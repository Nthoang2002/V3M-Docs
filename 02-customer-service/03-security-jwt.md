# customer-service — Security & JWT

3 class: `SecurityConfig`, `JwtAuthFilter`, `UserDetailsServiceImpl` (package `config/security`)
+ 2 util: `JwtUtil`, `RedisTokenService` (package `utils/auth`)

---

## 1. Luồng xác thực tổng quát

```
Request có header:  Authorization: Bearer eyJhbGci...
   │
   ▼
[JwtAuthFilter]  extends OncePerRequestFilter
   │  • lấy token sau "Bearer "
   │  • jwtUtil.validateToken(token)  → chữ ký + hạn
   │  • đọc claims: sub=userId, phone, role
   │  • SecurityContextHolder.setAuthentication(UsernamePasswordAuthenticationToken(
   │        principal = phone, authorities = ["ROLE_" + role]))
   │  • 🔑 request.setAttribute("userId", userId)
   │  • KHÔNG chặn nếu token sai → chỉ không set authentication
   ▼
[FilterSecurityInterceptor]  ← quyết định theo SecurityConfig
   │  • PUBLIC_URLS → permitAll
   │  • /earn-rules/** , /users/** , ... → hasRole("ADMIN")
   │  • còn lại → authenticated()  → không có auth = 401 (HttpStatusEntryPoint)
   ▼
Controller:  @RequestAttribute("userId") Long userId
```

🔑 **Điểm mấu chốt:** controller **không đọc JWT**, nó đọc `@RequestAttribute("userId")` mà filter đã set.
⚠️ Nếu filter không set (token thiếu/hết hạn) mà endpoint lại `permitAll` thì Spring ném `ServletRequestBindingException` → xem [04](04-exception-response.md), đó là nguồn gốc của bug SB-4902.

---

## 2. `JwtAuthFilter`

```java
@Component
@RequiredArgsConstructor
public class JwtAuthFilter extends OncePerRequestFilter {

    private final JwtUtil jwtUtil;

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response,
                                    FilterChain filterChain) throws ServletException, IOException {
        String token = extractToken(request);

        if (StringUtils.hasText(token) && jwtUtil.validateToken(token)) {
            try {
                Long userId  = jwtUtil.extractUserId(token);
                String phone = jwtUtil.extractPhone(token);
                String role  = jwtUtil.extractRole(token);

                UsernamePasswordAuthenticationToken auth = new UsernamePasswordAuthenticationToken(
                        phone, null, List.of(new SimpleGrantedAuthority("ROLE_" + role)));
                auth.setDetails(userId);
                SecurityContextHolder.getContext().setAuthentication(auth);
                request.setAttribute("userId", userId);           // 🔑
            } catch (Exception e) {
                log.error("Không thể set authentication từ JWT: {}", e.getMessage());
            }
        }
        filterChain.doFilter(request, response);                  // 🔑 LUÔN đi tiếp
    }
}
```

**Ba điều cần nhớ:**
1. `OncePerRequestFilter` — Spring đảm bảo filter chạy **đúng 1 lần** mỗi request (forward/include không chạy lại).
2. Filter **không bao giờ chặn**. Nó chỉ *cố gắng* set authentication. Việc chặn để `FilterSecurityInterceptor` làm — vì có endpoint public không cần token.
3. `"ROLE_" + role` — 🔑 Spring Security quy ước prefix `ROLE_`. `hasRole("ADMIN")` sẽ tìm authority `ROLE_ADMIN`. Quên prefix = phân quyền không bao giờ khớp.

---

## 3. `JwtUtil`

```java
@Component
public class JwtUtil {
    @Value("${app.jwt.secret}")               private String secret;
    @Value("${app.jwt.access-token-expiry}")  private long accessTokenExpiry;   // ms

    public String generateAccessToken(UserEntity user) {
        return Jwts.builder()
                .setSubject(user.getId().toString())         // 🔑 sub = userId
                .claim("phone", user.getPhone())
                .claim("role",  user.getRole().name())
                .setIssuedAt(new Date())
                .setExpiration(new Date(System.currentTimeMillis() + accessTokenExpiry))
                .signWith(getSigningKey(), SignatureAlgorithm.HS256)
                .compact();
    }

    public boolean validateToken(String token) {
        try { Jwts.parserBuilder().setSigningKey(getSigningKey()).build().parseClaimsJws(token); return true; }
        catch (ExpiredJwtException e) { log.warn("JWT expired: {}", e.getMessage()); }
        catch (JwtException e)        { log.warn("JWT invalid: {}", e.getMessage()); }
        return false;
    }

    private Key getSigningKey() { return Keys.hmacShaKeyFor(secret.getBytes(StandardCharsets.UTF_8)); }
}
```

| Đặc điểm | Giá trị |
|---|---|
| Thuật toán | **HS256** (đối xứng — cùng 1 secret ký & verify) |
| Claims | `sub` = userId · `phone` · `role` |
| Hạn | `app.jwt.access-token-expiry` (ms) |

🔑 **HS256 (đối xứng) có nghĩa là:** mọi service muốn verify token phải **biết secret**. `HrAppAuthProxy` gọi hr-backend kèm `Authorization: Bearer {user JWT}` và ghi rõ *"same secret as customer-service"* — tức hr-backend cũng giữ secret này.
💡 Nếu dùng RS256 (bất đối xứng) thì chỉ customer-service giữ private key, các service khác chỉ cần public key → an toàn hơn. Đây là điểm có thể cải thiện.

---

## 4. `RedisTokenService` — refresh token & OTP session

Toàn bộ trạng thái phiên nằm ở **Redis**, không nằm ở DB.

### Bảng key

| Key pattern | Value | TTL | Dùng cho |
|---|---|---|---|
| `auth:refresh:uid:{userId}` | token | `app.jwt.refresh-token-expiry` | logout theo userId |
| `auth:refresh:tkn:{token}` | userId | như trên | validate token → lấy userId |
| `auth:otp:session:{uuid}` | `userId:verifyKey` | 900s (15') | phiên OTP quên mật khẩu |
| `auth:otp:tokenotp:{tokenOtp}` | userId | 1800s (30') | vé đổi mật khẩu sau khi verify OTP |
| `auth:otp:lock:{userId}` | `"1"` | 5s | chống spam gửi OTP |
| `auth:register:pending:{uuid}` | JSON đăng ký | 900s | dữ liệu đăng ký chờ verify OTP |
| `auth:register:lock:{phone}` | `"1"` | 5s | chống spam OTP đăng ký |

### 🔑 Hai kỹ thuật đáng học

**(1) Lưu refresh token 2 chiều**
```java
public void saveRefreshToken(Long userId, String token) {
    redisTemplate.opsForValue().set(REFRESH_UID_PREFIX + userId, token, ttl, SECONDS);
    redisTemplate.opsForValue().set(REFRESH_TKN_PREFIX + token, userId.toString(), ttl, SECONDS);
}
```
Cần cả 2 chiều vì có 2 nhu cầu khác nhau:
- `logout(userId)` — biết userId, cần xoá token → dùng chiều `uid → token`
- `refresh(token)` — biết token, cần userId → dùng chiều `token → uid`

**(2) Lua script GET + DEL nguyên tử**
```java
private static final DefaultRedisScript<String> GET_DEL_SCRIPT = new DefaultRedisScript<>(
        "local v = redis.call('GET', KEYS[1])\n" +
        "if v then redis.call('DEL', KEYS[1]) end\n" +
        "return v", String.class);
```
Dùng cho `getAndDeleteTokenOtpUserId()` và `getAndDeleteRegisterPending()`.
🔑 **Vì sao?** Nếu làm 2 lệnh riêng (`GET` rồi `DEL`), 2 request đồng thời đều `GET` thành công trước khi `DEL` chạy → **cùng 1 tokenOtp đổi được mật khẩu 2 lần**. Redis chạy Lua **nguyên tử** (single-threaded) nên chỉ 1 request lấy được giá trị.

💡 Đây là dạng "compare-and-swap" cho token dùng-một-lần. Cùng ý tưởng với `setIfAbsent` (SETNX) dùng cho lock và dedup.

**(3) Lock 5 giây bằng `setIfAbsent`**
```java
public boolean tryAcquireOtpLock(Long userId) {
    return Boolean.TRUE.equals(redisTemplate.opsForValue()
            .setIfAbsent(OTP_LOCK_PREFIX + userId, "1", 5, TimeUnit.SECONDS));
}
```
Chặn user bấm "Gửi OTP" nhiều lần liên tiếp (và chặn 2 pod cùng gửi). TTL 5s tự nhả — không cần unlock thủ công, không sợ deadlock.

---

## 5. `SecurityConfig` — ⚠️ phần dễ sai nhất

```java
@Configuration @EnableWebSecurity
@EnableGlobalMethodSecurity(prePostEnabled = true)      // cho @PreAuthorize
public class SecurityConfig extends WebSecurityConfigurerAdapter {

    private static final String[] PUBLIC_URLS = {
            "/auth/**",
            "/admin/**",              // ⚠️⚠️ ĐỌC KỸ PHẦN DƯỚI
            "/actuator/**",
            "/swagger-ui.html", "/swagger-resources/**", "/v2/api-docs", "/webjars/**",
            // Internal/admin timekeeping — gọi bởi hr-backend hoặc CRM, không có JWT user
            "/timekeeping/sync", "/timekeeping/sync/updated", "/timekeeping/admin/**",
            "/timekeeping/missed-checkout", "/timekeeping/missed-checkout/reset",
            // app v2 cache endpoints (public)
            "/cache/version", "/master-data", "/recruitments/all", "/companies/all",
            // news (nội dung không nhạy cảm)
            "/news/hot", "/news/pin", "/news/normal", "/news/detail", "/news/detail-slug",
            "/internal/**",           // internal batch — auth ở gateway
            "/add-role-notification", // vỏ tương thích v3m-core-service (hr-backend gọi S2S)
            "/gifts/brands",
            "/agreements/current"
    };

    @Override
    protected void configure(HttpSecurity http) throws Exception {
        http.csrf().disable()
            .sessionManagement().sessionCreationPolicy(SessionCreationPolicy.STATELESS)
            .and()
            .authorizeRequests()
              .antMatchers(PUBLIC_URLS).permitAll()
              .antMatchers(HttpMethod.GET,  "/agreements/versions").permitAll()
              .antMatchers(HttpMethod.POST, "/agreements/versions").hasRole("ADMIN")
              .antMatchers("/earn-rules/**").hasRole("ADMIN")
              .antMatchers("/gifts/*/points").hasRole("ADMIN")
              .antMatchers("/gift-redemptions/**").hasRole("ADMIN")
              .antMatchers("/earn-transactions/**").hasRole("ADMIN")
              .antMatchers("/users/**").hasRole("ADMIN")
              .antMatchers("/gift-price-history/**").hasRole("ADMIN")
              .anyRequest().authenticated()
            .and()
            .exceptionHandling().authenticationEntryPoint(new HttpStatusEntryPoint(HttpStatus.UNAUTHORIZED))
            .and()
            .addFilterBefore(jwtAuthFilter, UsernamePasswordAuthenticationFilter.class);
    }
}
```

### ⚠️⚠️ BẪY LỚN NHẤT: `/admin/**` nằm trong `PUBLIC_URLS`

Comment trong code ghi rõ (SB-4838, SB-4842):
> *"KHÔNG dùng prefix `/admin/**` vì `/admin/**` đang nằm trong `PUBLIC_URLS` (permitAll) — sẽ hở nếu đặt endpoint vào đó."*

🔑 Vì thế các endpoint admin **thật sự** phải đặt ở path khác rồi khai `hasRole("ADMIN")` tường minh:
| Endpoint admin | Path (KHÔNG có `/admin`) |
|---|---|
| Tra cứu giao dịch đổi quà | `/gift-redemptions/**` |
| Tra cứu giao dịch tích điểm | `/earn-transactions/**` |
| Tra cứu user (tên/SĐT/điểm) | `/users/**` |
| Lịch sử set giá quà | `/gift-price-history/**` |
| CRUD nhiệm vụ | `/earn-rules/**` |
| Set điểm đổi quà | `/gifts/*/points` |

💡 **Bài học tổng quát:** một dòng permitAll đặt sai chỗ có thể vô hiệu hoá toàn bộ phân quyền của một nhóm API. Khi thêm endpoint mới, **luôn kiểm tra nó có bị prefix nào trong `PUBLIC_URLS` nuốt không**.

### Tách permission theo HTTP method
```java
.antMatchers(HttpMethod.GET,  "/agreements/versions").permitAll()
.antMatchers(HttpMethod.POST, "/agreements/versions").hasRole("ADMIN")
```
Cùng 1 path, GET public (app hiển thị danh sách phiên bản), POST chỉ admin (tạo phiên bản mới).
⚠️ Nếu để `/agreements/versions` trong `PUBLIC_URLS` thì POST cũng public → ai cũng tạo được phiên bản điều khoản.

### Các cấu hình khác
| Cấu hình | Ý nghĩa |
|---|---|
| `csrf().disable()` | API stateless dùng token, không dùng cookie session → CSRF không áp dụng |
| `SessionCreationPolicy.STATELESS` | Không tạo `HttpSession`. Mỗi request tự mang JWT |
| `HttpStatusEntryPoint(UNAUTHORIZED)` | Chưa auth → trả **401 rỗng** thay vì redirect trang login (mặc định của Spring) |
| `addFilterBefore(jwtAuthFilter, UsernamePasswordAuthenticationFilter.class)` | Đặt filter JWT **trước** filter form-login |
| `@EnableGlobalMethodSecurity(prePostEnabled = true)` | Bật `@PreAuthorize("hasRole('ADMIN')")` — dùng ở `CacheController.refreshAll()` |

---

## 6. `UserDetailsServiceImpl`

```java
@Override
public UserDetails loadUserByUsername(String phone) {
    UserEntity user = userRepository.findByPhone(phone)
            .orElseThrow(() -> new UsernameNotFoundException("Không tìm thấy user: " + phone));
    return new User(user.getPhone(), user.getPassword(),
                    List.of(new SimpleGrantedAuthority("ROLE_" + user.getRole().name())));
}
```
🔑 **`username` ở đây là SỐ ĐIỆN THOẠI** — hệ thống đăng nhập bằng phone, không có username riêng.
💡 Class này thực ra **ít được dùng**: luồng chính đăng nhập là `AuthServiceImpl.login()` tự so `passwordEncoder.matches()`, không đi qua `AuthenticationManager`. `UserDetailsService` chỉ được cấu hình vào `AuthenticationManagerBuilder` để `authenticationManagerBean()` hoạt động nếu cần.

`PasswordEncoder` = **BCrypt**.

## 7. Đi tiếp

→ [`04-exception-response.md`](04-exception-response.md)
