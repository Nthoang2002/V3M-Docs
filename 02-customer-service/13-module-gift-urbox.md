# customer-service — Module Gift (đổi điểm lấy quà Urbox)

Package `service/gift` — 5 class:
`GiftCacheService` (cache catalog) · `GiftPriceService` (giá điểm) · `GiftService` (facade) · `GiftRedemptionService` (đổi quà) · **`GiftRedemptionTxService`** (transaction)

---

## 1. Bảng endpoint (`GiftController`)

| Method | Path | Auth | Mô tả |
|---|---|---|---|
| GET | `/gifts/brands` | **public** | Danh sách thương hiệu |
| GET | `/gifts` | JWT | Danh sách quà + `pointCost` + lọc + tổng còn/hết hàng |
| PUT | `/gifts/{giftId}/points` | **ADMIN** | Cấu hình điểm đổi 1 quà (+ ghi audit) |
| POST | `/gifts/{giftId}/redeem` | JWT | 🔑 Đổi quà bằng điểm |
| GET | `/gifts/redemptions` | JWT | Lịch sử đổi quà + mã voucher |

🔑 `GET /gifts` **cần JWT** (khác `/gifts/brands` public) — vì `pointCost` gắn với ngữ cảnh điểm của user.

---

## 2. Ba bảng

| Bảng | Nội dung |
|---|---|
| `t_gift_price` | Giá **HIỆN TẠI**: `gift_id` (UNIQUE) → `points` |
| `t_gift_price_history` | 🔑 Audit **append-only**: `gift_id`, `old_points`, `new_points`, `changed_by_user_id`, `changed_at` |
| `t_gift_redemption` | Giao dịch đổi quà: `user_id`, `gift_id`, `quantity`, `points_cost`, `points_before`, `points_after`, `urbox_amount`, `transaction_id`, `campaign_code`, `status`, `urbox_response`, `voucher_codes`, `failure_reason` |

### ⚠️ Bẫy đặt tên cột
```java
// LƯU Ý: cột tên "gift_id" nhưng CHỨA Urbox item id (UrboxGiftItem.id, VD "5300") — mã voucher
// cụ thể dùng để redeem, KHÔNG phải trường gift_id (nhóm sản phẩm) của Urbox.
// Giữ tên cột cho ổn định (SB-4812: đã cân nhắc không đổi schema).
@Column(name = "gift_id", nullable = false, length = 50, unique = true)
private String giftId;
```
💡 Ghi rõ trong code khi tên cột không khớp ngữ nghĩa — tốt hơn nhiều so với đổi schema rồi phải migrate.

---

## 3. `GiftCacheServiceImpl` — mirror pattern MD5-version

Y hệt `HrCacheServiceImpl` (xem [08](08-module-cache-masterdata.md)): MD5 hash + version, Redis + `system_config`.
Redis key: `cache:data:gift-brand`, `cache:data:gift`, `cache:version:gift-brand`, `cache:version:gift`.

### `truncateOversizedOffice()` — cắt dữ liệu ngay lúc sync
```java
/**
 * Urbox trả office (địa điểm áp dụng) không kiểm soát — có gift lên tới HÀNG NGHÌN địa điểm,
 * làm nặng cache Redis + response API mà không có ý nghĩa hiển thị thực tế (app không có ngữ
 * cảnh vị trí user để chọn "gần nhất"). Cắt bớt NGAY LÚC SYNC, TRƯỚC khi hash/lưu cache —
 * KHÔNG cắt lúc trả response để tránh cache vẫn phình to mỗi lần sync.
 */
private void truncateOversizedOffice(List<UrboxGiftItem> gifts) {
    int max = urboxProperties.getMaxOfficePerGift();      // mặc định 50
    for (UrboxGiftItem gift : gifts)
        if (gift.getOffice() != null && gift.getOffice().size() > max) {
            log.warn("Gift có quá nhiều office, cắt bớt: giftId={}, total={}, kept={}", ...);
            gift.setOffice(gift.getOffice().subList(0, max));
        }
}
```
🔑 **Cắt ở đâu quan trọng**: cắt lúc trả response thì Redis vẫn chứa dữ liệu khổng lồ; cắt lúc sync thì cả cache lẫn response đều nhẹ.

---

## 4. `GiftServiceImpl` — facade + lọc + phân trang trong bộ nhớ

### Lọc quà bị cấm bán
```java
public List<UrboxGiftItem> getGifts() {
    // Urbox hiện chỉ cho dùng quà với type không thuộc urbox.excluded-gift-types — lọc tại TẦNG ĐỌC (facade),
    // giữ cache nguyên vẹn dữ liệu gốc để không phải re-sync khi đổi cấu hình.
    List<UrboxGiftItem> gifts = giftCacheService.getGifts().stream()
            .filter(gift -> {
                if (gift.getType() == null) {           // 🔑 Urbox không trả "type" cho 1 số item
                    log.warn("Gift thiếu field type, bỏ qua lọc excluded-gift-types: giftId={}", gift.getId());
                    return true;
                }
                return !urboxProperties.getExcludedGiftTypes().contains(gift.getType());
            })
            .collect(Collectors.toList());
    // gắn pointCost
    Map<String, Long> prices = giftPriceService.getPricesByGiftIds(giftIds);
    gifts.forEach(gift -> gift.setPointCost(prices.get(gift.getId())));
    return gifts;
}
```
⚠️ `gift.getType()` có thể `null` → `List.of()` (immutable list) ném **`NullPointerException`** khi gọi `contains(null)`. Phải check null trước — đây là bẫy Java thật (`List.of()` khác `Arrays.asList()`).
🔑 Lọc ở **tầng đọc** chứ không lúc sync → đổi `excluded-gift-types` trong config có hiệu lực **ngay**, không cần re-sync.

### Phân trang trong bộ nhớ (không phải JPA)
```java
// Nguồn dữ liệu là cache Redis (List trong bộ nhớ), không phải JPA repository — lọc + tự phân
// trang bằng subList thay vì query có WHERE/LIMIT/OFFSET.
int start = (int) pageable.getOffset();
// pageable.getOffset() là long (page * size) - ép sang int có thể TRÀN SỐ ÂM với page rất lớn;
// check < 0 cùng với >= size để tránh IndexOutOfBoundsException từ subList.
if (start < 0 || start >= gifts.size()) return new PageImpl<>(emptyList(), pageable, gifts.size());
int end = Math.min(start + pageable.getPageSize(), gifts.size());
return new PageImpl<>(gifts.subList(start, end), pageable, gifts.size());
```
⚠️ **Bẫy tràn số**: `getOffset()` là `long`. `?page=999999999&size=100` → offset vượt `Integer.MAX_VALUE` → ép `(int)` cho ra **số âm** → `subList` ném `IndexOutOfBoundsException` → 500. Check `< 0` xử lý đúng.

### `getStockSummary()` — tổng còn/hết hàng
```java
// Dùng lại ĐÚNG bộ lọc của getGifts(...) để tổng còn/hết KHỚP chính danh sách client đang thấy —
// tính trên TOÀN BỘ list đã lọc, không phải riêng 1 trang.
List<UrboxGiftItem> gifts = filterGifts(category, brand, title);
long inStock = gifts.stream().filter(GiftServiceImpl::isInStock).count();
return new GiftStockSummary(inStock, gifts.size() - inStock);

private static boolean isInStock(UrboxGiftItem g) {
    String quantity = g.getQuantity();                       // Urbox trả dạng CHUỖI
    if (quantity == null || quantity.trim().isEmpty()) { log.warn("...coi như hết hàng"); return false; }
    try { return Long.parseLong(quantity.trim()) > 0; }
    catch (NumberFormatException e) { log.warn("...không parse được, coi như hết hàng"); return false; }
}
```
🔑 Dữ liệu bất thường → **coi là hết hàng** (an toàn hơn coi là còn hàng) + log WARN để phát hiện.

### Lọc mềm dẻo
```java
private static boolean matchesCategory(UrboxGiftItem g, String category) {
    return isBlank(category) || category.equalsIgnoreCase(g.getCatId())
            || category.equalsIgnoreCase(g.getParentCatId()) || containsIgnoreCase(g.getCatTitle(), category);
}
```
1 tham số khớp **nhiều field** (id chính xác HOẶC tên chứa) → app gửi id hay tên đều được.

---

## 5. 🔑🔑 `redeem()` — đổi quà, và bài toán 3 transaction

### Bài toán
Đổi quà gồm 3 việc: **(a) trừ điểm** (DB của mình) → **(b) gọi Urbox** (HTTP ngoài) → **(c) ghi kết quả** (DB của mình).
- Bọc cả 3 trong 1 transaction: giữ connection DB suốt thời gian chờ HTTP → cạn pool. Và nếu Urbox thành công mà commit fail thì **mất voucher**.
- Không transaction: 2 request đồng thời cùng đọc số dư → **double-spend điểm**.

### Giải pháp: tách 3 transaction độc lập bằng `REQUIRES_NEW`

```java
public RedeemGiftResponse redeem(Long userId, String giftId, int quantity) {
    // Dùng GiftService.getGifts() (đã lọc excluded-gift-types) chứ không phải giftCacheService.getGifts() (raw) —
    // nếu không, quà bị loại trừ khỏi GET /gifts vẫn có thể đổi được bằng cách gọi thẳng giftId đã biết.
    UrboxGiftItem gift = giftService.getGifts().stream().filter(g -> giftId.equals(g.getId()))
            .findFirst().orElseThrow(() -> new ValidationException("Quà không tồn tại"));

    UserEntity user = userRepository.findById(userId).orElseThrow(...);
    long urboxAmount = parseAmount(gift);

    // ── TX 1: trừ điểm + tạo bản ghi PENDING ──────────────────────────
    GiftRedemptionEntity redemption = txService.reserve(userId, gift, quantity, urboxAmount, campaignCode);

    // ── Gọi Urbox (NGOÀI transaction) ─────────────────────────────────
    UrboxRedeemResult result = urboxClient.redeemGift(String.valueOf(userId), user.getPhone(),
            redemption.getTransactionId(), giftId, quantity, urboxAmount);

    if (!result.isSuccess()) {
        // ── TX 2a: hoàn điểm + đánh dấu FAILED ────────────────────────
        txService.markFailedAndRefund(redemption.getId(), userId, redemption.getPointsCost(),
                giftId, gift.getTitle(), result.getRawResponse(), result.getMessage());
        log.error("Gift redeem failed: userId={}, giftId={}, transactionId={}, reason={}", ...);
        throw new ValidationException("Đổi quà thất bại: " + result.getMessage());
    }

    // ── TX 2b: đánh dấu SUCCESS + lưu voucher ─────────────────────────
    txService.markSuccess(redemption.getId(), result.getRawResponse(), result.getVouchers());
    ...
}
```

### ⚠️ Vì sao PHẢI tách bean `GiftRedemptionTxService`
Javadoc ghi rõ:
> *"Tách riêng khỏi `GiftRedemptionServiceImpl` để mỗi phase là 1 transaction commit độc lập (`REQUIRES_NEW`) — cùng lý do đã áp dụng cho `UserSyncItemService`: **gọi qua self (`this.xxx()`) sẽ bypass `@Transactional` của Spring (proxy AOP)**, nên phải tách bean riêng. Nhờ vậy nếu Urbox lỗi, việc hoàn điểm (`markFailedAndRefund`) **không bị cuốn theo rollback** của transaction đã trừ điểm trước đó."*

🔑 **Đây là kiến thức Spring cốt lõi**: `@Transactional`, `@Async`, `@Cacheable` đều qua **proxy**. Gọi nội bộ trong cùng class = không qua proxy = annotation vô tác dụng.

---

## 6. `GiftRedemptionTxService` — 3 method

### `reserve()` — trừ điểm với **khoá pessimistic**

```java
@Transactional(propagation = Propagation.REQUIRES_NEW)
public GiftRedemptionEntity reserve(Long userId, UrboxGiftItem gift, int quantity, long urboxAmount, String campaignCode) {
    Long unitPointCost = giftPriceService.getPricesByGiftIds(List.of(gift.getId())).get(gift.getId());
    if (unitPointCost == null) throw new ValidationException("Quà chưa được cấu hình giá, không thể đổi");
    long totalPointsCost = unitPointCost * quantity;

    // 🔑 Khoá row (PESSIMISTIC_WRITE) — 2 request đổi quà đồng thời của cùng user KHÔNG được
    // cùng đọc số dư trước khi 1 trong 2 commit (tránh double-spend điểm)
    UserPoint userPoint = userPointRepository.findByUserIdForUpdate(userId)
            .orElseGet(() -> UserPoint.builder().userId(userId).build());
    if (userPoint.getTotalPoints() < totalPointsCost) throw new ValidationException("Không đủ điểm để đổi quà này");

    long pointsBefore = userPoint.getTotalPoints();
    long pointsAfter  = pointsBefore - totalPointsCost;
    userPoint.setTotalPoints((int) (userPoint.getTotalPoints() - totalPointsCost));
    userPointRepository.save(userPoint);

    pointTransactionRepository.save(PointTransaction.builder()
            .userId(userId).points((int) -totalPointsCost)       // 🔑 ÂM = trừ
            .type(TransactionType.REDEEM).giftId(gift.getId())
            .note("Đổi quà: " + gift.getTitle()).build());

    GiftRedemptionEntity redemption = giftRedemptionRepository.save(GiftRedemptionEntity.builder()
            ... .transactionId("PENDING").status(GiftRedemptionStatus.PENDING).build());
    // transaction_id gửi Urbox phải UNIQUE — dùng lại id tự tăng của chính row này
    redemption.setTransactionId(String.format("%011d", redemption.getId()));
    return giftRedemptionRepository.save(redemption);
}
```

**Khoá pessimistic:**
```java
/**
 * Khoá row (SELECT ... FOR UPDATE) — dùng cho luồng đổi quà để tránh 2 request đổi quà đồng thời
 * của cùng 1 user cùng đọc trước khi commit (double-spend điểm).
 * KHÔNG đổi findByUserId (dùng ở awardPoints/rule engine) để tránh ảnh hưởng luồng khác ngoài phạm vi.
 */
@Lock(LockModeType.PESSIMISTIC_WRITE)
@Query("SELECT u FROM UserPoint u WHERE u.userId = :userId")
Optional<UserPoint> findByUserIdForUpdate(@Param("userId") Long userId);
```
🔑 Thêm **query mới** thay vì sửa query cũ — thay đổi tối thiểu, không ảnh hưởng luồng rule engine.

**`transaction_id` = id tự tăng, pad 11 số:**
```java
redemption.setTransactionId(String.format("%011d", redemption.getId()));    // 1 → "00000000001"
```
🔑 Urbox yêu cầu unique. Dùng lại PK của chính row (`IDENTITY` nên có ngay sau `save` đầu) → chắc chắn unique, không cần sinh UUID hay counter riêng. Phải `save` 2 lần: lần 1 để có id, lần 2 để ghi transactionId.

**`points_before` / `points_after` (SB-4842):**
```java
// SB-4842: chốt số dư trước/sau NGAY TẠI ĐÂY — đang giữ trong biến nên KHÔNG TỐN QUERY NÀO.
```
🔑 Thay vì cộng dồn `t_point_transaction` mỗi lần admin đọc, snapshot ngay lúc ghi. Đọc cũng miễn phí.
⚠️ Giao dịch trước `V057` có `null` — không backfill (*"replay toàn bộ transaction không tương xứng chi phí"*).

### `markFailedAndRefund()` — hoàn điểm
```java
@Transactional(propagation = Propagation.REQUIRES_NEW)
public void markFailedAndRefund(Long redemptionId, Long userId, long pointsCost, String giftId,
                                String giftTitle, String rawResponse, String failureReason) {
    UserPoint userPoint = userPointRepository.findByUserIdForUpdate(userId)...;   // 🔑 lại khoá
    userPoint.setTotalPoints((int) (userPoint.getTotalPoints() + pointsCost));
    userPointRepository.save(userPoint);

    pointTransactionRepository.save(PointTransaction.builder()
            .userId(userId).points((int) pointsCost)             // 🔑 DƯƠNG = hoàn
            .type(TransactionType.REFUND)                        // 🔑 loại riêng, không phải EARN
            .giftId(giftId).note("Hoàn điểm — đổi quà thất bại: " + giftTitle).build());

    redemption.setStatus(GiftRedemptionStatus.FAILED);
    redemption.setUrboxResponse(rawResponse);
    redemption.setFailureReason(failureReason != null && failureReason.length() > 500
            ? failureReason.substring(0, 500) : failureReason);       // 🔑 cắt cho vừa cột
}
```
🔑 **`REFUND` là loại riêng** (không dùng `EARN`) → sổ cái phân biệt được "điểm kiếm được" và "điểm hoàn". `PointHistoryDirection.EARNED` lọc `points >= 0` nên **gồm cả REFUND** (đúng ý nghĩa "điểm vào").

💡 Comment ở entity: *"Giao dịch FAILED đã hoàn điểm vẫn giữ giá trị `points_before/after` lúc trừ — **status=FAILED là dấu hiệu điểm đã hoàn**."*

### `markSuccess()` — lưu mã voucher
```java
redemption.setStatus(GiftRedemptionStatus.SUCCESS);
redemption.setUrboxResponse(rawResponse);
if (vouchers != null && !vouchers.isEmpty()) {
    try { redemption.setVoucherCodes(objectMapper.writeValueAsString(vouchers)); }
    catch (Exception e) { log.warn("Không serialize được voucherCodes: ..."); }   // 🔑 không ném
}
```
⚠️ Voucher đã đổi thành công rồi — serialize lỗi mà ném exception thì rollback `status=SUCCESS`, user mất voucher trong hệ thống dù Urbox đã cấp.

### ⚠️ Điểm yếu còn lại
Nếu app **crash giữa** `reserve()` và `markSuccess()`, bản ghi kẹt `PENDING`: điểm đã trừ, không biết Urbox có cấp voucher không. **Chưa có job đối soát** cho trạng thái này.

---

## 7. `UrboxClient` + `UrboxSignatureUtil` — ký RSA

```java
/**
 * Sinh chữ ký RSA-SHA256 cho API đổi quà Urbox (cartPayVoucher) theo tài liệu Urbox:
 * ksort data theo key → json_encode → ký bằng private key (SHA256withRSA) → base64.
 * CHỈ áp dụng cho các field Urbox yêu cầu ký (app_id, app_secret, campaign_code, dataBuy,
 * isSendSms, site_user_id, transaction_id) — KHÔNG ký toàn bộ request body
 * (VD: ttphone KHÔNG nằm trong tập field ký theo tài liệu).
 */
```
🔑 **`ksort`** — sắp key theo alphabet trước khi serialize. Bắt buộc: 2 bên phải sinh **chuỗi giống hệt** để chữ ký khớp. Thứ tự key trong JSON là không xác định nếu không sort.
🔑 **Chỉ ký tập field quy định** — thừa/thiếu 1 field là chữ ký sai. `ttphone` gửi trong body nhưng **không ký**.

```java
private static final int PAGE_SIZE = 200;   // Urbox trả toàn bộ items trong 1 trang nếu per_page đủ lớn
private static final int MAX_PAGES = 50;    // 🔑 chặn vòng lặp vô hạn nếu Urbox trả totalPage bất thường
```
💡 `MAX_PAGES` — phòng thủ khi API đối tác trả `totalPage` sai (vd luôn trả 999). Luôn có giới hạn cứng khi lặp theo dữ liệu của bên thứ ba.

---

## 8. `GiftPriceServiceImpl` — audit set giá

```java
@Transactional
public boolean setPoints(String giftId, Long points, Long actorUserId) {
    GiftPriceEntity entity = giftPriceRepository.findByGiftId(giftId).orElse(null);
    Long oldPoints = entity != null ? entity.getPoints() : null;

    // No-op: admin bấm Lưu mà không đổi gì -> KHÔNG ghi history (tránh rác), KHÔNG bump version.
    if (oldPoints != null && oldPoints.equals(points)) {
        log.info("Gift price unchanged, skip: giftId={}, points={}, actorUserId={}", ...);
        return false;                                    // 🔑 trả false để caller bỏ qua việc kèm theo
    }

    if (entity == null) entity = GiftPriceEntity.builder().giftId(giftId).build();
    entity.setPoints(points);
    giftPriceRepository.save(entity);

    // Audit: t_gift_price chỉ giữ giá HIỆN TẠI nên phải ghi riêng mới trace được ai sửa, từ → thành
    giftPriceHistoryRepository.save(GiftPriceHistoryEntity.builder()
            .giftId(giftId).oldPoints(oldPoints).newPoints(points)
            .changedByUserId(actorUserId).build());
    return true;
}
```
🔑 **Trả `boolean`** thay vì `void` — caller biết có thay đổi thật không để quyết định bump version cache.
🔑 `old_points = null` nghĩa là **lần đầu** cấu hình giá cho quà đó.

## 9. Đi tiếp

→ [`14-module-reward-incentive.md`](14-module-reward-incentive.md)
