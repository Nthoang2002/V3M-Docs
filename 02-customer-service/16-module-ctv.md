# customer-service — Module CTV (trở thành cộng tác viên)

Class: `service/ctv/impl/CtvServiceImpl.java` (259 dòng) · `controller/ctv/CtvController.java`
Bảng: `t_ctv_contract` · Template: `resources/templates/ctv-contract-template.html` · Font: `resources/fonts/DejaVuSans*.ttf`

---

## 1. Hai endpoint

| Method | Path | Mô tả |
|---|---|---|
| GET | `/ctv/contract` | Xem trạng thái xác thực + nội dung hợp đồng (PDF xem trước) |
| POST | `/ctv/contract/sign` | Ký hợp đồng (= **trở thành CTV**) — idempotent |

## 2. 🔑 Định nghĩa "là CTV"

```java
/**
 * Trở thành CTV = tồn tại t_user.ctv_contract_url (KHÔNG dùng bảng riêng — tái sử dụng field sẵn có,
 * trước đây chỉ được ghi từ CRM sync, nay app tự sinh file hợp đồng lúc user ký).
 */
```
`t_ctv_contract` được thêm sau (SB-4955) chỉ để **lưu vết** (audit): mốc đăng ký, mốc ký, URL hợp đồng, status.
🔑 **Nguồn sự thật vẫn là `t_user.ctv_contract_url`** — `t_ctv_contract` là bảng phụ trợ, được đồng bộ theo.

---

## 3. Luồng 2 bước

```
[GET /ctv/contract]
   ├─ chưa verified (KYC) → trả { verified: false, signed: false }  🔑 KHÔNG ném lỗi
   │     app tự điều hướng sang luồng xác thực căn cước
   ├─ đã có ctv_contract_url → ensureSignedRecord() + trả bản đã ký
   └─ verified + chưa ký:
        • tạo bản ghi PENDING (registered_at) nếu chưa có — idempotent
        • render PDF xem trước lên CÙNG objectKey với bản ký
        • KHÔNG set t_user.ctv_contract_url → vẫn signed=false
        • trả presigned URL

[POST /ctv/contract/sign]
   ├─ chưa verified → ValidationException "Cần xác thực căn cước trước khi ký hợp đồng"
   ├─ đã ký → idempotent, trả lại bản đã ký (KHÔNG render lại)
   └─ chưa ký:
        • render PDF → upload S3 PRIVATE
        • t_user.ctv_contract_url = objectKey       ← 🔑 đây mới là "đã ký"
        • t_ctv_contract: status=SIGNED, signed_at=now, contract_url=objectKey
        • trả presigned URL
```

### 🔑 Chưa KYC → trả `verified: false` chứ KHÔNG ném lỗi
```java
if (!Boolean.TRUE.equals(user.getIsVerified())) {
    // Chưa xác thực căn cước = chưa thực sự bắt đầu luồng CTV → không tạo bản ghi lưu vết.
    return CtvContractResponse.builder().verified(false).signed(false).build();
}
```
Javadoc interface: *"vì đây là **điều hướng UI bình thường** chứ không phải lỗi"*.
💡 **Nguyên tắc thiết kế API**: trạng thái mà client cần xử lý bằng cách điều hướng ≠ lỗi. Trả 200 với cờ trạng thái, không trả 4xx.

⚠️ Nhưng `POST /sign` **thì ném lỗi** khi chưa verified — vì đó là thao tác ghi, client gọi sai luồng.

### 🔑 Dùng CHUNG 1 objectKey cho cả xem trước và bản ký
```java
// Dùng CHUNG 1 object key cho cả xem trước lẫn bản ký — nội dung PDF y hệt (cùng template + field từ t_user).
// "Đã ký hay chưa" quyết bằng t_user.ctv_contract_url, KHÔNG bằng sự tồn tại của file:
// trước khi ký mỗi lần GET ghi đè lại (nội dung không đổi); sau khi ký GET trả thẳng bản đã lưu
// (không render lại) nên bản ký ổn định.
private String contractObjectKey(Long userId) { return "ctv/" + userId + "/contract.pdf"; }
```
🔑 Tách trạng thái (DB) khỏi dữ liệu (file) → không cần dọn file rác, không có 2 phiên bản file.

---

## 4. Render PDF — iText html2pdf

```java
private static final String TEMPLATE_PATH = "templates/ctv-contract-template.html";
private static final String[] FONT_PATHS = {"fonts/DejaVuSans.ttf", "fonts/DejaVuSans-Bold.ttf"};

@PostConstruct
void loadTemplate() {
    try (InputStream is = new ClassPathResource(TEMPLATE_PATH).getInputStream()) {
        templateRaw = StreamUtils.copyToString(is, StandardCharsets.UTF_8);
    } catch (IOException e) {
        log.error("Không đọc được template hợp đồng CTV: ...");
        throw new IllegalStateException("Không load được template hợp đồng CTV", e);   // 🔑 SẬP luôn
    }
    fontProvider = new FontProvider();
    fontProvider.addStandardPdfFonts();
    for (String path : FONT_PATHS) {
        try (InputStream is = new ClassPathResource(path).getInputStream()) {
            fontProvider.addFont(StreamUtils.copyToByteArray(is));
        } catch (IOException e) { throw new IllegalStateException("Không load được font hợp đồng CTV", e); }
    }
}
```

🔑 **Font bundle trong jar** — comment giải thích:
> *"iText cần font hỗ trợ tiếng Việt để render dấu đúng (**không phụ thuộc font hệ điều hành trong container**). DejaVu Sans phủ đầy đủ tiếng Việt."*

⚠️ Container Docker `openjdk:11-jre` **không có font tiếng Việt** → PDF sẽ ra ô vuông/mất dấu nếu dựa vào font hệ thống.

⚠️ **Ở đây `@PostConstruct` CỐ Ý ném exception** (sập context) — khác `FcmConfig` (trả null để không sập).
Lý do khác nhau: template/font là **tài nguyên trong jar**, thiếu = build sai, phải phát hiện ngay lúc khởi động. Còn Firebase credential là **cấu hình môi trường**, thiếu ở môi trường dev là bình thường.

### `renderTemplate()` — escape HTML
```java
String renderTemplate(UserEntity user) {   // package-private để unit-test verify escape
    // "Ngày hợp đồng" = ngày CTV đăng ký tài khoản (t_user.created_at); fallback thời điểm ký nếu thiếu.
    String contractDate = (user.getCreatedAt() != null ? user.getCreatedAt() : LocalDateTime.now()).format(DATE_FMT);
    // Nội dung render ra HTML rồi convert PDF → ESCAPE mọi giá trị người dùng tự nhập
    // (họ tên, địa chỉ, sđt) để tránh HTML INJECTION phá vỡ bố cục PDF.
    // contractId/contractDate do hệ thống sinh (số + ngày) nên an toàn.
    return templateRaw
            .replace("{{contractId}}", String.format("%06d", user.getId()))
            .replace("{{contractDate}}", contractDate)
            .replace("{{fullName}}", esc(user.getFullName()))
            .replace("{{address}}",  esc(user.getAddress()))
            .replace("{{phone}}",    esc(user.getPhone()));
}
private String esc(String value) { return value != null ? HtmlUtils.htmlEscape(value) : ""; }
```
🔑 **HTML injection trong PDF** là rủi ro thật: user đặt `fullName = "<h1>...</h1>"` → phá bố cục hợp đồng. Escape mọi giá trị do user nhập.
💡 `package-private` (không `private`) để unit test verify được kết quả escape mà không phải render PDF thật.

### `renderPdf()`
```java
private byte[] renderPdf(UserEntity user) {
    String html = renderTemplate(user);
    ByteArrayOutputStream out = new ByteArrayOutputStream();
    ConverterProperties props = new ConverterProperties();
    props.setFontProvider(fontProvider);
    props.setCharset("UTF-8");
    try { HtmlConverter.convertToPdf(html, out, props); }
    catch (Exception e) { throw new IllegalStateException("Không tạo được PDF hợp đồng CTV", e); }
    return out.toByteArray();
}
```

---

## 5. Lưu PRIVATE + presigned URL

```java
private void uploadPdf(byte[] pdf, String objectKey) {
    MultipartFile file = new InMemoryMultipartFile("contract", "contract.pdf", "application/pdf", pdf);
    storageService.upload(file, objectKey, "application/pdf");        // 🔑 PRIVATE (không uploadPublic)
}
```

```java
// Lưu objectKey (KHÔNG phải URL) vào t_user.ctv_contract_url — nội dung chứa PII đầy đủ
// (họ tên, sđt, địa chỉ) nên KHÔNG dùng getPublicUrl() (vĩnh viễn, không xác thực,
// objectKey ĐOÁN ĐƯỢC từ userId tuần tự) — build lại presigned URL (hết hạn, ký) mỗi lần đọc.
```
⚠️ Đây là lý do rất quan trọng: `ctv/{userId}/contract.pdf` — `userId` tuần tự nên **ai cũng đoán được objectKey của người khác**. Public URL = lộ toàn bộ hợp đồng của mọi CTV.

### `resolveContractUrl()` — xử lý 2 dạng dữ liệu
```java
/**
 * t_user.ctv_contract_url mang 2 dạng: URL đầy đủ (đồng bộ từ CRM, dùng thẳng) hoặc objectKey S3
 * nội bộ (app tự ký). Bản ghi cũ (.txt/.html ký trước SB-4652) vẫn resolve được vì hàm này
 * chỉ dựng presigned URL theo objectKey bất kỳ.
 */
private String resolveContractUrl(String stored) {
    if (stored.startsWith("http://") || stored.startsWith("https://")) return stored;
    return storageService.getPresignedUrl(stored, PRESIGNED_EXPIRY_DAYS);   // 7 ngày
}
```
(Hàm y hệt cũng có trong `ProfileServiceImpl` — 2 chỗ đọc cùng 1 cột.)

---

## 6. `t_ctv_contract` + `ensureSignedRecord()` — xử lý dữ liệu cũ

```java
@Entity @Table(name = "t_ctv_contract")
public class CtvContractEntity {
    Long id; Long userId;                       // UNIQUE user_id — 1 record/user
    LocalDateTime registeredAt;                 // lần đầu mở hợp đồng
    LocalDateTime signedAt;                     // null khi chưa ký
    String contractUrl;                         // snapshot lúc ký
    CtvContractStatus status;                   // PENDING | SIGNED
}
```
Javadoc: *"`created_at`/`updated_at` do DB tự quản (`DEFAULT CURRENT_TIMESTAMP` / `ON UPDATE`) nên **không map vào entity** — các mốc nghiệp vụ dùng `registeredAt`/`signedAt`."*
💡 Không map cột DB tự quản vào entity là cách tránh Hibernate ghi đè giá trị DB sinh.

```java
/**
 * Đảm bảo tồn tại bản ghi lưu vết SIGNED cho user ĐÃ ký (SB-4955). Xử lý bản ghi CŨ (ký trước khi
 * có bảng này — app cũ hoặc CRM sync): tạo mới với mốc XẤP XỈ = created_at tài khoản (best-effort,
 * không có mốc ký thật). Nếu đã có bản ghi PENDING mà t_user lại có contract (vd CRM sync sau)
 * → đồng bộ lên SIGNED.
 */
private CtvContractEntity ensureSignedRecord(UserEntity user) {
    CtvContractEntity record = ctvContractRepository.findByUserId(user.getId()).orElse(null);
    if (record == null) {
        LocalDateTime fallback = user.getCreatedAt() != null ? user.getCreatedAt() : LocalDateTime.now();
        record = ctvContractRepository.save(CtvContractEntity.builder()
                .userId(user.getId()).registeredAt(fallback).signedAt(fallback)
                .contractUrl(user.getCtvContractUrl()).status(CtvContractStatus.SIGNED).build());
    } else if (record.getStatus() != CtvContractStatus.SIGNED) {
        record.setStatus(CtvContractStatus.SIGNED);
        if (record.getSignedAt() == null)    record.setSignedAt(LocalDateTime.now());
        if (record.getContractUrl() == null) record.setContractUrl(user.getCtvContractUrl());
        ctvContractRepository.save(record);
    }
    return record;
}
```
🔑 **Backfill lười (lazy backfill)** — thay vì viết migration quét toàn bộ user cũ, tự vá **khi user đó truy cập**.
Ưu điểm: không cần downtime, không cần script. Nhược điểm: user không bao giờ vào thì không có bản ghi (chấp nhận được — họ cũng không cần).

## 7. Đi tiếp

→ [`17-module-admin.md`](17-module-admin.md)
