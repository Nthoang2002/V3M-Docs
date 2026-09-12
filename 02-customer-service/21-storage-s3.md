# customer-service — Object Storage (S3-compatible)

Interface: `service/storage/iface/StorageService.java` · Impl: `S3StorageService.java` (113 dòng)
Config: `config/S3Config.java`, `S3Properties.java` (xem [02](02-khoi-dong-config.md))
SDK: **AWS SDK v2** · Nhà cung cấp: **FPT Object Storage** (nền Ceph)

---

## 1. Interface

```java
/**
 * Object storage (FPT Object Storage, S3-compatible). 1 BUCKET DÙNG CHUNG; phân tách file theo prefix
 * objectKey (kyc/, avatars/, ctv/). File nhạy cảm (CCCD, hợp đồng) upload PRIVATE → đọc qua presigned URL;
 * ảnh mặt/avatar upload PUBLIC-READ → đọc qua public URL vĩnh viễn.
 */
public interface StorageService {
    String upload(MultipartFile file, String objectKey);                       // PRIVATE, image/jpeg
    String upload(MultipartFile file, String objectKey, String contentType);   // PRIVATE, content-type tuỳ chọn
    String uploadPublic(MultipartFile file, String objectKey);                 // PUBLIC-READ, image/jpeg
    String getPublicUrl(String objectKey);
    String getPresignedUrl(String objectKey, int expiryDays);
    byte[] downloadToBytes(String objectKey);
}
```

## 2. 🔑 Bảng: file nào private, file nào public

| Prefix | Nội dung | ACL | Đọc bằng | Vì sao |
|---|---|---|---|---|
| `kyc/{userId}/` | Ảnh CCCD mặt trước/sau | **PRIVATE** | presigned 7 ngày | PII nhạy cảm nhất |
| `kyc/migrate/{userId}/` | Ảnh CCCD migrate từ CRM | **PRIVATE** | presigned | như trên |
| `avatars/{userId}/` | Ảnh mặt KYC (selfie) | **PUBLIC-READ** | public URL | 🔑 Dùng làm ảnh tham chiếu **chấm công** — cần đọc bất cứ lúc nào, presigned sẽ hết hạn |
| `ctv/{userId}/contract.pdf` | Hợp đồng CTV | **PRIVATE** | presigned 7 ngày | Chứa họ tên/SĐT/địa chỉ, và objectKey **đoán được** từ userId tuần tự |
| `timekeeping/{yyyy}/{MM}/{dd}/{userId}/` | Ảnh chụp lúc chấm công | **PUBLIC-READ** | public URL | 🔑 CRM admin mở bằng `<img src>` bất kỳ lúc nào (dữ liệu lịch sử) |

🔑 **Nguyên tắc chọn:**
- Cần đọc **định kỳ/lâu dài bởi hệ thống khác** → PUBLIC-READ
- Chỉ chủ sở hữu đọc, đọc **thỉnh thoảng** → PRIVATE + presigned

⚠️ Đánh đổi của PUBLIC-READ: objectKey đoán được ⇒ ai biết `userId` là xem được ảnh. Với ảnh selfie/chấm công thì chấp nhận (không phải giấy tờ), với CCCD/hợp đồng thì **không**.

---

## 3. `S3StorageService`

```java
private static final String DEFAULT_CONTENT_TYPE = "image/jpeg";

private String put(MultipartFile file, String objectKey, String contentType, ObjectCannedACL acl) {
    try {
        PutObjectRequest.Builder req = PutObjectRequest.builder()
                .bucket(props.getBucket()).key(objectKey).contentType(contentType);
        if (acl != null) req.acl(acl);                          // 🔑 chỉ set ACL khi public
        s3Client.putObject(req.build(), RequestBody.fromInputStream(file.getInputStream(), file.getSize()));
        log.info("S3 upload success: bucket={}, objectKey={}, public={}", props.getBucket(), objectKey, acl != null);
        return objectKey;                                       // 🔑 trả objectKey, KHÔNG phải URL
    } catch (Exception e) {
        log.error("S3 upload failed: bucket={}, objectKey={}, debug={}", ...);
        throw new RuntimeException("Lỗi khi tải file lên storage: " + e.getMessage(), e);
    }
}
```
🔑 **Luôn trả `objectKey`** — mọi nơi trong service lưu objectKey vào DB, URL chỉ dựng ở biên đọc.
💡 `RequestBody.fromInputStream(is, size)` — cần `size` tường minh vì S3 phải biết `Content-Length` trước khi stream.

### `getPublicUrl()` — path-style
```java
@Override
public String getPublicUrl(String objectKey) {
    // Path-style: {endpoint}/{bucket}/{objectKey} — chỉ hợp lệ cho object upload PUBLIC-READ.
    String base = props.getEndpoint();
    if (base.endsWith("/")) base = base.substring(0, base.length() - 1);
    return base + "/" + props.getBucket() + "/" + objectKey;
}
```
💡 Ghép chuỗi thủ công (không dùng SDK) — nhanh, không cần gọi mạng. Xử lý dấu `/` thừa ở cuối endpoint.

### `getPresignedUrl()`
```java
PresignedGetObjectRequest presigned = s3Presigner.presignGetObject(
        GetObjectPresignRequest.builder()
                .signatureDuration(Duration.ofDays(expiryDays))
                .getObjectRequest(GetObjectRequest.builder().bucket(...).key(objectKey).build())
                .build());
return presigned.url().toString();
```
💡 **Presigned URL** = URL có chữ ký + hạn dùng nhúng trong query string. Ai có URL thì đọc được **cho tới khi hết hạn**, không cần credential. Tạo hoàn toàn **offline** (không gọi mạng).

---

## 4. 🔑 Ba flag cấu hình — mỗi flag một sự cố

(Chi tiết ở [02](02-khoi-dong-config.md), nhắc lại vì quan trọng)

```java
private S3Configuration pathStyle() {
    return S3Configuration.builder()
            .pathStyleAccessEnabled(true)
            .checksumValidationEnabled(false)
            .chunkedEncodingEnabled(false)
            .build();
}
```

| Flag | Triệu chứng nếu không tắt |
|---|---|
| `pathStyleAccessEnabled(true)` | AWS mặc định `bucket.endpoint/key`; FPT (Ceph) chỉ hiểu `endpoint/bucket/key` → 404/NoSuchBucket |
| `checksumValidationEnabled(false)` | SDK ký kèm header `x-amz-te` vào presigned GET; **browser/curl không gửi header đó** → **403 SignatureDoesNotMatch** |
| `chunkedEncodingEnabled(false)` | SDK dùng `aws-chunked` transfer-encoding khi PUT — nhiều S3-compatible **không nhận** |

💡 **Bài học:** "S3-compatible" **không có nghĩa là tương thích 100%**. Ceph/MinIO/FPT đều thiếu vài tính năng của AWS. Khi gặp lỗi lạ, tắt các tối ưu của SDK trước.

---

## 5. Cách đặt objectKey — 4 chiến lược

| Nơi | Mẫu | Chiến lược |
|---|---|---|
| KYC CCCD | `kyc/{userId}/front_{ts}.jpg` | 🔑 **userId trong key** → `startsWith` là kiểm tra sở hữu (chống IDOR) |
| KYC face | `avatars/{userId}/face_{ts}.jpg` | timestamp → không ghi đè, giữ lịch sử |
| Hợp đồng CTV | `ctv/{userId}/contract.pdf` | 🔑 **key cố định** → xem trước và bản ký dùng chung, không sinh file rác |
| Ảnh chấm công | `timekeeping/{yyyy}/{MM}/{dd}/{userId}/evident_{HHmmssSSS}.jpg` | 🔑 **ngày trước userId** → lifecycle rule dọn theo prefix ngày |

🔑 **Ba nguyên tắc rút ra:**
1. **Nhúng thông tin sở hữu vào key** khi cần kiểm tra quyền rẻ tiền
2. **Nhúng thời gian vào prefix** khi cần vận hành theo thời gian (dọn dẹp, archive)
3. **Key cố định** khi file là "trạng thái hiện tại", **key có timestamp** khi cần lịch sử

---

## 6. Bảng: URL dựng ở đâu

| Nơi | Hàm | Cho ai |
|---|---|---|
| `KycServiceImpl.toProfileResponse()` | `getPresignedUrl(cccd*, 7)` + `getPublicUrl(face)` | App hiển thị hồ sơ |
| `ProfileServiceImpl.resolveContractUrl()` | `getPresignedUrl(contract, 7)` | App xem hợp đồng |
| `CtvServiceImpl.resolveContractUrl()` | như trên | App xem hợp đồng |
| `TimekeepServiceImpl.resolveFaceImageUrl()` | `getPublicUrl(kycFaceUrl)` | Gửi cho EKYC AI đối chiếu |
| `TimekeepServiceImpl.toSyncItem()` | `getPublicUrl(evidentImage)` | 🔑 CRM (không biết bucket/endpoint) |

💡 **Nguyên tắc lặp lại:** DB lưu **định danh ổn định** (objectKey); URL dựng **ở biên đọc**. Đổi bucket/domain = không phải migrate dữ liệu.

## 7. Đi tiếp

→ [`22-utils-crypto.md`](22-utils-crypto.md)
