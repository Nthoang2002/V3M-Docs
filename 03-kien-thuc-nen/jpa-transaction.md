# Kiến thức nền — JPA & Transaction

---

## 1. `@Transactional` — 4 điều phải nhớ

### (1) Chỉ hoạt động qua proxy
```java
this.method()      // ❌ KHÔNG qua proxy → annotation vô tác dụng
otherBean.method() // ✅
```
→ Xem 3 ví dụ tách bean trong dự án ở [`spring-boot-annotations.md`](spring-boot-annotations.md).

### (2) Propagation
| Giá trị | Ý nghĩa | Dùng ở đâu |
|---|---|---|
| `REQUIRED` (mặc định) | Tham gia transaction đang có, chưa có thì tạo | Hầu hết |
| **`REQUIRES_NEW`** | 🔑 **Luôn tạo transaction mới**, tạm treo cái đang có | `UserSyncItemService.syncOne`, `GiftRedemptionTxService.*`, `notifyMissionCompleted` |

⚠️ **`REQUIRES_NEW` cần connection thứ 2** — đây chính là lý do `MissionEnrollmentService` **từ chối** dùng nó:
> *"transaction riêng luôn cần connection thứ 2, chính là nguyên nhân **cạn pool**. Chạy trong transaction của caller thì mỗi request chỉ 1 connection."*

### (3) Rollback mặc định chỉ với `RuntimeException`
Checked exception **không** rollback (trừ khi khai `rollbackFor`). Trong dự án mọi exception nghiệp vụ đều là `RuntimeException` (`ValidationException`, `ResponseStatusException`, …) nên không gặp vấn đề này.

### (4) 🔑 Rollback-only — `try/catch` không cứu được
Từ Javadoc `MissionEnrollmentService`:
> *"Nếu xảy ra thì request đó 500... **KHÔNG bắt exception ở đây vì trong cùng transaction, catch không cứu được (tx đã rollback-only)**."*

Khi một `RuntimeException` thoát ra khỏi 1 method `@Transactional` (kể cả bị bắt ở tầng ngoài), Spring/Hibernate đã đánh dấu transaction `rollback-only`. Lúc commit sẽ ném `UnexpectedRollbackException`.
🔑 Muốn "lỗi ở A không ảnh hưởng B" thì **phải tách transaction** (`REQUIRES_NEW`), không phải `try/catch`.

### `readOnly = true`
```java
@Transactional(readOnly = true)
public List<MissionProgressResponse> getMissionProgress(Long userId) { ... }
```
Gợi ý cho Hibernate bỏ dirty-checking → nhanh hơn, và bắt lỗi nếu vô tình ghi.
⚠️ `getAvailableMissions` **cố ý KHÔNG readOnly** vì nó ghi (auto-enroll).

---

## 2. 🔑 N+1 query — vấn đề số 1 của JPA

### Triệu chứng
```java
List<RuleConditionEntity> conditions = repo.findByEventType(type);   // 1 query
for (RuleConditionEntity c : conditions) {
    c.getGroup().getEarnRule().getName();                            // +2 query MỖI dòng (LAZY)
}
// 100 dòng → 201 query
```

### Ba cách chữa dùng trong dự án

**(a) `JOIN FETCH`**
```java
@Query("SELECT rc FROM RuleConditionEntity rc " +
       "JOIN FETCH rc.group g JOIN FETCH g.earnRule er " +
       "WHERE rc.triggerEventType = :eventType AND er.status = :status ...")
List<RuleConditionEntity> findActiveByTriggerEventType(...);
```
1 query nạp cả 3 bảng.
💡 `LEFT JOIN FETCH` khi quan hệ có thể rỗng (`DisplayConditionGroupRepository` dùng `LEFT JOIN FETCH g.conditions` để group không có condition vẫn về).
💡 `SELECT DISTINCT` cần thiết với `JOIN FETCH` collection (tránh nhân dòng).

**(b) Batch load + Map** (dùng nhiều nhất)
```java
Map<Long, UserEntity> users = userRepository.findAllById(distinctIds).stream()
        .collect(Collectors.toMap(UserEntity::getId, Function.identity(), (a, b) -> a));
return page.map(t -> toItem(t, users));
```
🔑 1 query cho cả trang thay vì N query.
💡 `(a, b) -> a` — merge function bắt buộc, tránh `IllegalStateException: Duplicate key`.

**(c) `FetchType.EAGER` khi luôn cần**
```java
/** EAGER vì mọi response mission/earn-rule đều cần code+name+path của router; LAZY sẽ gây N+1 ở list. */
@ManyToOne(fetch = FetchType.EAGER) @JoinColumn(name = "router_id")
private AppRouterEntity router;
```
⚠️ EAGER chỉ đúng khi: quan hệ many-to-one + bảng đích nhỏ + **luôn** được dùng.

---

## 3. Projection — chỉ SELECT cột cần

```java
/** Chỉ SELECT id: không nạp entity, tránh kéo cột payload (TEXT) về chỉ để lấy 1 số. */
@Query("SELECT a.hrProfileId FROM ApplyEntity a WHERE a.referralId = :referralId AND a.hrProfileId IS NOT NULL")
List<Long> findHrProfileIdsByReferralId(@Param("referralId") Long referralId);

/** Chỉ SELECT id: không nạp entity, KHÔNG KÉO PII VỀ CHỈ ĐỂ LỌC. */
@Query("SELECT u.id FROM UserEntity u WHERE LOWER(u.fullName) LIKE ... OR u.phone LIKE ...")
List<Long> findIdsByFullNameOrPhoneContaining(@Param("kw") String kw);
```
🔑 Hai lý do dùng projection trong dự án: (1) tránh kéo cột `TEXT`/`LOB` nặng, (2) **tránh kéo PII về** khi chỉ cần lọc.

---

## 4. Derived query vs `@Query` vs Specification

| Cách | Khi nào | Ví dụ |
|---|---|---|
| **Derived query** (đặt tên method) | Điều kiện cố định, ít tham số | `findByUserIdAndTimeDateBetweenOrderByTimeCheckAsc` |
| **`@Query` (JPQL)** | Cần JOIN FETCH, projection, hoặc điều kiện phức tạp | `findActiveByTriggerEventType` |
| **`@Query(nativeQuery=true)`** | JPQL không diễn đạt được | `findMissedCheckouts` (`NOT EXISTS` self-join) |
| **`JpaSpecificationExecutor`** | 🔑 Nhiều filter **optional** | `AdminTransactionServiceImpl` (8 filter → 256 tổ hợp) |
| **`JdbcTemplate` SQL thô** | Cần cú pháp DB đặc thù | `MissionEnrollmentService` (`ON DUPLICATE KEY UPDATE`) |

### `@Modifying`
```java
@Modifying(clearAutomatically = true)
@Query("UPDATE UserDeviceEntity d SET d.isActive = false WHERE d.fcmToken IN :tokens")
int deactivateByFcmTokenIn(@Param("tokens") List<String> tokens);
```
🔑 `@Modifying` bắt buộc cho UPDATE/DELETE.
🔑 `clearAutomatically = true` — xoá persistence context sau khi chạy, tránh entity trong cache còn giá trị cũ.
⚠️ Bulk update **bỏ qua** `@LastModifiedDate` và các callback JPA (phải tự set `updatedAt = CURRENT_TIMESTAMP` như `TimekeepRecordRepository.updateStatus`).

---

## 5. 🔑 Khoá (locking)

### Pessimistic — khoá hàng ở DB
```java
/**
 * Khoá row (SELECT ... FOR UPDATE) — dùng cho luồng đổi quà để tránh 2 request đổi quà đồng thời
 * của cùng 1 user cùng đọc trước khi commit (DOUBLE-SPEND điểm).
 */
@Lock(LockModeType.PESSIMISTIC_WRITE)
@Query("SELECT u FROM UserPoint u WHERE u.userId = :userId")
Optional<UserPoint> findByUserIdForUpdate(@Param("userId") Long userId);
```
🔑 Dùng khi: **đọc-rồi-ghi trên cùng hàng, tranh chấp thật, hậu quả là tiền/điểm**.
⚠️ Giữ khoá suốt transaction → **không được gọi HTTP trong transaction có khoá**.
💡 Trong dự án chỉ dùng đúng 1 chỗ (đổi quà). `awardPoints` cố ý **không** dùng (tranh chấp hiếm + đã có dedup Redis).

### Thay thế: `ON DUPLICATE KEY UPDATE` (upsert nguyên tử)
```sql
INSERT INTO t_user_rule_progress (...) VALUES (...), (...) ON DUPLICATE KEY UPDATE id = id
```
🔑 Không cần khoá, không cần đọc trước. DB tự xử lý xung đột bằng unique index.
💡 Đây thường là giải pháp **tốt hơn** khoá pessimistic cho bài toán "tạo nếu chưa có".

### Chống deadlock: sắp thứ tự
```java
List<Row> ordered = rows.stream()
        .sorted(Comparator.comparing((Row r) -> r.getConditionId().toString()).thenComparing(Row::getPeriodKey))
        .collect(Collectors.toList());
```
🔑 Mọi transaction khoá index **cùng chiều** → không thể ôm khoá chéo.

---

## 6. Cascade & orphanRemoval

```java
@OneToMany(mappedBy = "earnRule", cascade = CascadeType.ALL, orphanRemoval = true)
@OrderBy("sortOrder ASC")
private List<RuleConditionGroupEntity> groups = new ArrayList<>();
```

### 🔑 `clear()` + `addAll()`, KHÔNG `setGroups(newList)`
```java
rule.getGroups().clear();
rule.getGroups().addAll(buildGroups(request.getGroups(), rule));
```
Hibernate theo dõi **chính đối tượng collection**. Gán list mới làm mất tracking:
```
A collection with cascade="all-delete-orphan" was no longer referenced by the owning entity instance
```

⚠️ **Hệ quả nghiệp vụ** của "xoá rồi tạo lại": `rule_condition.id` đổi sau mỗi lần update → `t_user_rule_progress.condition_id` mồ côi → tiến độ user reset.

---

## 7. `@Enumerated(EnumType.STRING)` — luôn STRING

```java
@Enumerated(EnumType.STRING)
@Column(nullable = false, length = 20)
private SyncStatus syncStatus = SyncStatus.PENDING;
```
⚠️ `ORDINAL` (mặc định nếu không khai) lưu **số thứ tự**. Thêm 1 giá trị vào giữa enum ⇒ **toàn bộ dữ liệu cũ lệch nghĩa**. Trong dự án 100% dùng STRING.

---

## 8. `@PrePersist` / `@PreUpdate`

```java
@PrePersist
protected void onCreate() {
    if (id == null) id = UUID.randomUUID().toString();
    LocalDateTime now = LocalDateTime.now();
    if (createdAt == null) createdAt = now;
    if (updatedAt == null) updatedAt = now;
    if (timekeepingStatus == null) timekeepingStatus = 1;
    if (isFailed == null) isFailed = false;
}
@PreUpdate
protected void onUpdate() { updatedAt = LocalDateTime.now(); }
```
💡 Dùng khi cần logic phức tạp hơn `@CreatedDate` (sinh UUID, giá trị mặc định có điều kiện).
⚠️ **Không chạy** với bulk update (`@Modifying @Query`).

### `@CreatedDate` / `@LastModifiedDate`
```java
@EntityListeners(AuditingEntityListener.class)
public class UserEntity {
    @CreatedDate      @Column(name = "created_at", updatable = false) private LocalDateTime createdAt;
    @LastModifiedDate @Column(name = "updated_at")                    private LocalDateTime updatedAt;
}
```
Cần `@EnableJpaAuditing` ở Application class.
💡 Ngược lại, `CtvContractEntity` **cố ý không map** `created_at`/`updated_at` vì DB tự quản (`DEFAULT CURRENT_TIMESTAMP`/`ON UPDATE`).

---

## 9. Phân trang

```java
Page<GiftRedemptionEntity> findByUserId(Long userId, Pageable pageable);
```
```java
@PageableDefault(size = 20, sort = "createdAt", direction = Sort.Direction.DESC) Pageable pageable
```
💡 Sort lấy từ `Pageable` → **không lặp lại trong tên method** (comment ở `GiftRedemptionRepository` ghi rõ).

⚠️ **Phân trang trong bộ nhớ** (`GiftServiceImpl`) phải tự phòng thủ:
```java
int start = (int) pageable.getOffset();       // getOffset() là long → có thể TRÀN thành số âm
if (start < 0 || start >= gifts.size()) return new PageImpl<>(emptyList(), pageable, gifts.size());
```

---

## 10. Bẫy: `Page` + `JOIN FETCH` collection

Nếu `@Query` có `JOIN FETCH` một `@OneToMany` **và** trả `Page`, Hibernate sẽ nạp **toàn bộ** rồi phân trang trong bộ nhớ (log warning `HHH000104: firstResult/maxResults specified with collection fetch; applying in memory`).
💡 Trong dự án các `JOIN FETCH` collection đều trả `List` (không `Page`) nên không gặp.
