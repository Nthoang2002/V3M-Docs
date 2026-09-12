# customer-service — Module Admin (tra cứu giao dịch)

Class: `service/admin/impl/AdminTransactionServiceImpl.java` (426 dòng) · `controller/admin/AdminTransactionController.java`
Ticket: SB-4838 (tra cứu) + SB-4842 (audit + bộ lọc + trường mới)

---

## 1. Bảng endpoint — ⚠️ KHÔNG có prefix `/admin`

| Method | Path | Auth | Mô tả |
|---|---|---|---|
| GET | `/gift-redemptions` | ADMIN | Lọc/tìm/phân trang giao dịch **đổi quà** |
| GET | `/gift-redemptions/filter-option` | ADMIN | Options combo box (danh mục/thương hiệu/tên quà) — **0 query DB** |
| GET | `/gift-redemptions/{id}` | ADMIN | Chi tiết 1 giao dịch đổi quà |
| GET | `/earn-transactions` | ADMIN | Lọc/tìm/phân trang giao dịch **tích điểm** |
| GET | `/earn-transactions/{id}` | ADMIN | Chi tiết |
| GET | `/earn-transactions/filter-option` | ADMIN | Options combo "Nhiệm vụ" |
| GET | `/users/{userId}` | ADMIN | Tên/SĐT user (cho màn chi tiết) |
| GET | `/users/{userId}/points` | ADMIN | Tổng điểm HIỆN TẠI |
| GET | `/gift-price-history` | ADMIN | Lịch sử set điểm đổi quà |

🔑 Comment trong code lặp lại 2 lần:
> *"Đặt ở `/users/**` + `hasRole(ADMIN)` — **KHÔNG đặt vào `/admin/**` vì prefix đó đang nằm trong `PUBLIC_URLS` (permitAll), sẽ hở tên/SĐT/số điểm**."*

Xem [03](03-security-jwt.md).

---

## 2. 🔑 JPA Specification API — query động

```java
public interface GiftRedemptionRepository extends JpaRepository<GiftRedemptionEntity, Long>,
        JpaSpecificationExecutor<GiftRedemptionEntity> { ... }
```

```java
Specification<GiftRedemptionEntity> spec = (root, q, cb) -> {
    List<Predicate> ps = new ArrayList<>();
    if (giftIdFilter != null) ps.add(root.get("giftId").in(giftIdFilter));
    if (userIdFilter != null) ps.add(root.get("userId").in(userIdFilter));
    if (status != null)       ps.add(cb.equal(root.get("status"), status));
    if (code != null && !code.trim().isEmpty()) ps.add(cb.equal(root.get("transactionId"), code.trim()));
    addDateRange(ps, cb, root.get("createdAt"), from, to);
    return cb.and(ps.toArray(new Predicate[0]));
};
return giftRedemptionRepository.findAll(spec, pageable).map(e -> toRedemptionItem(e, gifts));
```

💡 **Vì sao Specification chứ không `@Query`?**
8 tham số filter đều optional → `2^8 = 256` tổ hợp. Viết JPQL với `(:x IS NULL OR col = :x)` cho 8 field vừa dài vừa làm hỏng index plan. Specification **chỉ thêm predicate khi có giá trị** → SQL sinh ra tối giản.

### Khoảng ngày — `to` inclusive theo NGÀY
```java
/** created_at trong [from 00:00, to+1 00:00) — to inclusive theo ngày. */
private static void addDateRange(List<Predicate> ps, CriteriaBuilder cb,
                                 Path<LocalDateTime> createdAt, LocalDate from, LocalDate to) {
    if (from != null) ps.add(cb.greaterThanOrEqualTo(createdAt, from.atStartOfDay()));
    if (to != null)   ps.add(cb.lessThan(createdAt, to.plusDays(1).atStartOfDay()));
}
```
🔑 `< to+1 00:00` chứ không `<= to 23:59:59` — tránh mất giao dịch lúc `23:59:59.500` (cột là `datetime` có phần giây lẻ).

---

## 3. 🔑 Lọc theo dữ liệu KHÔNG có trong DB

**Vấn đề:** admin muốn lọc theo **thương hiệu**/**danh mục** quà. Nhưng `t_gift_redemption` chỉ có `gift_id` — brand/category nằm ở **catalog Urbox (Redis cache)**.

**Giải pháp:** quy về tập `giftId` **trong bộ nhớ** rồi tận dụng predicate `gift_id IN (...)` sẵn có.

```java
/**
 * SB-4842: gộp 3 bộ lọc thuộc catalog quà thành 1 tập giftId (GIAO NHAU — AND giữa các nhóm).
 * "Đối tác" = brand (catalog Urbox không có field partner riêng) nên dùng chung brandIds.
 * @return null nếu KHÔNG lọc theo quà; TẬP RỖNG nếu lọc nhưng không quà nào khớp
 */
private Set<String> resolveGiftIdFilter(List<String> giftIds, List<String> brandIds,
                                        List<String> catIds, Map<String, UrboxGiftItem> gifts) {
    boolean byCatalog = notEmpty(brandIds) || notEmpty(catIds);
    if (!notEmpty(giftIds) && !byCatalog) return null;

    Set<String> result = notEmpty(giftIds) ? new HashSet<>(giftIds) : null;
    if (byCatalog) {
        Set<String> matched = gifts.values().stream()
                .filter(g -> !notEmpty(brandIds) || brandIds.contains(g.getBrandId()))
                .filter(g -> !notEmpty(catIds)   || catIds.contains(g.getCatId()))
                .map(UrboxGiftItem::getId).collect(Collectors.toSet());
        if (result == null) result = matched; else result.retainAll(matched);   // 🔑 giao nhau
    }
    return result;
}
```

🔑 **Quy ước `null` vs tập rỗng** — rất quan trọng:
| Giá trị trả về | Nghĩa | Xử lý ở caller |
|---|---|---|
| `null` | Không lọc theo quà | Không thêm predicate |
| Tập **rỗng** | Có lọc nhưng **không quà nào khớp** | 🔑 `return Page.empty()` — **không chạm DB** |
| Tập có phần tử | Lọc theo tập này | `root.get("giftId").in(set)` |

```java
if (giftIdFilter != null && giftIdFilter.isEmpty()) return Page.empty(pageable);  // khỏi chạm DB
```

Cùng quy ước cho `resolveUserIdFilter()`:
```java
/**
 * userKeyword match tên HOẶC số điện thoại (chứa, bỏ hoa/thường).
 * @return null nếu không lọc theo user; tập rỗng nếu lọc nhưng không user nào khớp
 */
```
```java
// Chỉ tốn query này KHI có userKeyword — không truyền thì đường đọc HOÀN TOÀN KHÔNG ĐỤNG t_user.
Set<Long> userIdFilter = resolveUserIdFilter(userIds, userKeyword);
```

```java
@Query("SELECT u.id FROM UserEntity u WHERE LOWER(u.fullName) LIKE LOWER(CONCAT('%', :kw, '%')) "
        + "OR u.phone LIKE CONCAT('%', :kw, '%')")
List<Long> findIdsByFullNameOrPhoneContaining(@Param("kw") String kw);
```
🔑 `SELECT u.id` (projection) — *"không nạp entity, **không kéo PII về chỉ để lọc**"*.

---

## 4. 🔑 SB-4842 — bỏ tên/SĐT khỏi danh sách để giảm query

Javadoc interface:
> *"danh sách **CHỈ trả `userId`**, không kèm tên/SĐT — trước đây mỗi lần đọc phải chạy thêm 1 query `t_user` chỉ để hiển thị. Tên/SĐT lấy ở `getRedemptionDetail`."*

```java
// KHÔNG nạp user cho danh sách (SB-4842): chỉ trả userId. Tên/SĐT lấy ở getRedemptionDetail.
return giftRedemptionRepository.findAll(spec, pageable).map(e -> toRedemptionItem(e, gifts));
```

🔑 Đổi lại UI: admin bấm vào 1 dòng mới gọi `GET /users/{userId}` + `GET /users/{userId}/points`.
💡 **Đánh đổi rõ ràng:** danh sách nhanh hơn (bớt 1 query/request) ↔ chi tiết tốn thêm 2 request. Danh sách được đọc nhiều hơn chi tiết rất nhiều lần → đúng chiều tối ưu.

⚠️ Lưu ý: `searchEarnTransactions` **vẫn** enrich tên/SĐT trong danh sách (`usersByIds`) — 2 API không đồng nhất. Có thể là chỗ chưa dọn.

---

## 5. Enrich helper — chống N+1

```java
/** Batch nạp user theo id (bỏ null/trùng) → map id → UserEntity. */
private Map<Long, UserEntity> usersByIds(Collection<Long> ids) {
    Set<Long> distinct = ids.stream().filter(Objects::nonNull).collect(Collectors.toSet());
    if (distinct.isEmpty()) return Map.of();
    return userRepository.findAllById(distinct).stream()
            .collect(Collectors.toMap(UserEntity::getId, Function.identity(), (a, b) -> a));
}

/** Batch nạp earn rule theo id → map id → EarnRuleEntity. */
private Map<UUID, EarnRuleEntity> rulesByIds(Collection<UUID> ids) { ... }

/** Map giftId → UrboxGiftItem từ cache (để enrich tên/brand/danh mục quà). */
private Map<String, UrboxGiftItem> giftMap() {
    return giftCacheService.getGifts().stream().filter(g -> g.getId() != null)
            .collect(Collectors.toMap(UrboxGiftItem::getId, Function.identity(), (a, b) -> a));
}
```
🔑 Pattern lặp lại: **1 query `findAllById` cho cả trang** → `Map` → tra khi map từng dòng. Không bao giờ `findById` trong vòng lặp.

```java
Page<PointTransaction> page = pointTransactionRepository.findAll(spec, pageable);
Map<Long, UserEntity>     users = usersByIds(page.map(PointTransaction::getUserId).getContent());
Map<UUID, EarnRuleEntity> rules = rulesByIds(page.map(PointTransaction::getEarnRuleId).getContent());
return page.map(t -> toEarnItem(t, users, rules));
```
Tổng: **3 query** cho cả trang 20 dòng (thay vì 1 + 20×2 = 41).

---

## 6. `getRedemptionFilterOptions()` — 0 query DB

```java
@Override
public AdminRedemptionFilterOptions getRedemptionFilterOptions() {
    // 0 query DB — dựng từ cache quà Urbox (đọc 1 lần, distinct theo id, sort theo tên)
    List<UrboxGiftItem> gifts = giftCacheService.getGifts();
    return AdminRedemptionFilterOptions.builder()
            .categories(options(gifts, UrboxGiftItem::getCatId,   UrboxGiftItem::getCatTitle))
            .brands(    options(gifts, UrboxGiftItem::getBrandId, UrboxGiftItem::getBrandName))
            .gifts(     options(gifts, UrboxGiftItem::getId,      UrboxGiftItem::getTitle))
            .build();
}

/** Distinct theo id (giữ tên gặp đầu tiên), bỏ id rỗng, sort theo tên cho UI. */
private List<Option> options(List<UrboxGiftItem> gifts, Function<UrboxGiftItem,String> idFn,
                             Function<UrboxGiftItem,String> nameFn) {
    Map<String, String> byId = new LinkedHashMap<>();
    for (UrboxGiftItem g : gifts) {
        String id = idFn.apply(g);
        if (id == null || id.trim().isEmpty()) continue;
        byId.putIfAbsent(id, nameFn.apply(g));         // 🔑 putIfAbsent = giữ giá trị đầu tiên
    }
    return byId.entrySet().stream().map(en -> Option.builder().id(en.getKey()).name(en.getValue()).build())
            .sorted(Comparator.comparing(o -> o.getName() == null ? "" : o.getName(), String.CASE_INSENSITIVE_ORDER))
            .collect(Collectors.toList());
}
```
🔑 1 hàm generic `options()` dùng cho 3 loại combo — truyền `Function` để trích id/name.
🔑 `String.CASE_INSENSITIVE_ORDER` + xử lý null → sort ổn định, không NPE.

---

## 7. `parseVouchers()` — parse JSON của chính row

```java
/** SB-4842: parse voucher_codes JSON của chính row đang fetch — KHÔNG query thêm. */
private List<VoucherCodeResponse> parseVouchers(GiftRedemptionEntity e) {
    if (e.getVoucherCodes() == null || e.getVoucherCodes().isEmpty()) return List.of();
    try {
        List<UrboxVoucherItem> parsed = objectMapper.readValue(e.getVoucherCodes(), new TypeReference<>() {});
        return parsed.stream().map(v -> VoucherCodeResponse.builder()...build()).collect(toList());
    } catch (Exception ex) {
        log.warn("Không parse được voucherCodes: redemptionId={}, debug={}", e.getId(), DebuggingDTO.build(ex));
        return List.of();                    // 🔑 không ném — 1 dòng hỏng không làm vỡ cả trang
    }
}
```

## 8. `getUserTotalPoints()` — 0 điểm ≠ 404

```java
// Chưa từng có giao dịch điểm -> không có row t_user_point -> trả 0 thay vì 404
Integer total = userPointRepository.findByUserId(userId).map(UserPoint::getTotalPoints).orElse(0);
```

## 9. `searchGiftPriceHistory()` — 2 nhánh query

```java
Page<GiftPriceHistoryEntity> page = (giftId != null && !giftId.trim().isEmpty())
        ? giftPriceHistoryRepository.findByGiftIdOrderByChangedAtDesc(giftId.trim(), pageable)
        : giftPriceHistoryRepository.findAllByOrderByChangedAtDesc(pageable);
```
💡 Chỉ 1 tham số optional → 2 derived query đơn giản hơn nhiều so với Specification.
🔑 Chỉ trả `changedByUserId`, tra tên qua `GET /users/{userId}` — cùng nguyên tắc "không kéo PII vào danh sách".

## 10. Đi tiếp

→ [`18-tich-hop-3rd-party.md`](18-tich-hop-3rd-party.md)
