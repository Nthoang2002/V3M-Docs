# customer-service — Module Rule Config (cấu hình nhiệm vụ)

Package: `service/rule/config`, `entities/rule/config`
Endpoint: `/earn-rules/**` — **toàn bộ `hasRole("ADMIN")`**

---

## 1. Mô hình dữ liệu — 🔑 cây 3 tầng

```
earn_rule (1 nhiệm vụ)
   │  name, description, point, reset_period, category, router_id, start_date, end_date, status
   │
   ├── rule_condition_group[]      ← ĐIỀU KIỆN HOÀN THÀNH
   │      │  next_operator (AND/OR nối với group sau), sort_order
   │      └── rule_condition[]
   │             trigger_event_type, rule_type (COUNT/SUM/STREAK), value, value_to,
   │             filter_operator, sum_field, next_operator, sort_order
   │
   └── earn_rule_display_group[]   ← ĐIỀU KIỆN HIỂN THỊ (SB-4386)
          │  next_operator, sort_order
          └── earn_rule_display_condition[]
                 required_earn_rule_id  ← nhiệm vụ TIỀN ĐỀ phải hoàn thành trước
                 next_operator, sort_order
```

🔑 **Hai loại điều kiện hoàn toàn khác nhau — đừng nhầm:**

| | `groups` (rule_condition_group) | `displayGroups` (earn_rule_display_group) |
|---|---|---|
| Trả lời câu hỏi | "Làm gì thì **HOÀN THÀNH** nhiệm vụ?" | "Ai được **THẤY** nhiệm vụ?" |
| Điều kiện dựa trên | Event từ Kafka (`trigger_event_type`) | Nhiệm vụ tiền đề đã `rewarded` |
| Rỗng nghĩa là | Nhiệm vụ không bao giờ hoàn thành (bị chặn ở validate) | **Hiển thị cho tất cả** |

### Biểu thức logic
Cả 2 loại đều dựng biểu thức 2 tầng:
```
group1  AND/OR  group2  AND/OR  group3
  │
  └─ cond1 AND/OR cond2 AND/OR cond3
```
`next_operator` nằm ở **phần tử hiện tại**, nối nó với phần tử **kế tiếp**. Phần tử **cuối** phải có `next_operator = null`.

⚠️ **Đánh giá TUẦN TỰ trái→phải, KHÔNG có độ ưu tiên toán tử.**
`A AND B OR C` được tính là `((A AND B) OR C)` chứ không phải `A AND (B OR C)`.
→ Xem code `isEarnRuleComplete()` ở [12](12-module-rule-engine.md).

---

## 2. Các enum

| Enum | Giá trị | Ý nghĩa |
|---|---|---|
| `RuleStatus` | `ACTIVE`, `INACTIVE` | Bật/tắt nhiệm vụ |
| `ResetPeriod` | `NONE`, `DAILY`, `WEEKLY`, `MONTHLY` | 🔑 Chu kỳ lặp lại (quyết định `period_key`) |
| `MissionCategory` | `DAILY`, `WEEKLY`, `MONTHLY`, `EVENT`, `SPECIAL` | Nhóm hiển thị trên app |
| `RuleType` | `COUNT`, `STREAK`, `SUM` | 🔑 Cách tính tiến độ |
| `StreakUnit` | `DAY`, `WEEK`, `MONTH` | (khai báo nhưng engine dùng `ResetPeriod` để tính streak) |
| `OperatorCode` | `EQ NEQ GT GTE LT LTE BETWEEN IN NOT_IN` | So sánh |
| `LogicalOperator` | `AND`, `OR` | Nối group/condition |
| `DataType` | `NUMBER BOOLEAN STRING DATE CHECKLIST` | Kiểu dữ liệu event type |
| `EventTypeCategory` | `EVENT`, `CUSTOMER_INFO` | Phân loại event type |

### 🔑 `RuleType` — 3 cách tính tiến độ

| Type | Mỗi event làm gì | Ví dụ nhiệm vụ |
|---|---|---|
| `COUNT` | `currentCount += 1` | "Ứng tuyển 3 việc" |
| `SUM` | `currentCount += metadata[sumField]` | "Làm đủ 100 giờ" |
| `STREAK` | Chuỗi kỳ **liên tiếp** (đứt thì về 1) | "Đăng nhập 7 ngày liên tiếp" |

---

## 3. `earn_rule` — lưu UUID dạng `BINARY(16)`

```java
@Id @GeneratedValue
@Column(columnDefinition = "BINARY(16)")
private UUID id;
```
⚠️ **Khác** `t_user.customer_id` (dùng `uuid-char` = `VARCHAR(36)`). Trong cùng 1 DB có **2 cách lưu UUID**.
💡 `BINARY(16)` gọn hơn (16 vs 36 byte), index nhanh hơn — nhưng query bằng tay phải `HEX(id)`.
🔑 Điều này ảnh hưởng trực tiếp `MissionEnrollmentService` — nó viết SQL thô nên phải tự convert UUID → `byte[]`:
```java
private static byte[] toBytes(UUID uuid) {
    return ByteBuffer.allocate(16)
            .putLong(uuid.getMostSignificantBits())      // 🔑 đúng thứ tự Hibernate ghi
            .putLong(uuid.getLeastSignificantBits()).array();
}
```

## 4. `router` — màn hình app (SB-4815)

```java
/**
 * 1 màn hình của app = 1 router. Dùng để cấu hình nhiệm vụ hiển thị ở màn nào.
 * Danh sách do APP quy định → seed cứng bằng migration (V053), KHÔNG có API tạo/sửa/xoá:
 * admin chỉ chọn từ danh sách. Thêm màn mới = thêm migration mới, deploy cùng bản app có route đó.
 */
@Entity @Table(name = "t_app_router")
public class AppRouterEntity { Integer id; String code; String name; String path; ... Boolean isActive; }
```

```java
@ManyToOne(fetch = FetchType.EAGER)          // 🔑 EAGER có chủ ý
@JoinColumn(name = "router_id")
private AppRouterEntity router;
```
Javadoc: *"EAGER vì **mọi response** mission/earn-rule đều cần code+name+path của router; **LAZY sẽ gây N+1** ở list."*

💡 Đây là ví dụ **EAGER đúng chỗ**: quan hệ many-to-one tới bảng nhỏ, luôn được dùng. Ngược lại `RuleConditionEntity.group` để LAZY (không phải lúc nào cũng cần).

`IAppRouterService.getActiveRouterOrThrow(routerId)` — validate router tồn tại + đang bật trước khi gán vào earn_rule.

---

## 5. `EarnRuleServiceImpl` — CRUD

### `create()`
```java
@Transactional
public EarnRuleDetailResponse create(CreateEarnRuleRequest request) {
    validationService.validateGroups(request.getGroups());
    validationService.validateDisplayGroups(request.getDisplayGroups(), null);   // null = tạo mới

    EarnRuleEntity rule = EarnRuleEntity.builder()... .build();
    rule.setGroups(buildGroups(request.getGroups(), rule));
    rule.setDisplayGroups(buildDisplayGroups(request.getDisplayGroups(), rule));
    EarnRuleEntity saved = earnRuleRepository.save(rule);          // 🔑 cascade lưu cả cây
    return queryService.findById(saved.getId());
}
```
🔑 `@OneToMany(cascade = CascadeType.ALL, orphanRemoval = true)` trên `groups`/`displayGroups` → chỉ cần `save(rule)`, Hibernate tự INSERT group + condition.

### `update()` — 🔑 xoá sạch rồi tạo lại
```java
// orphanRemoval = true trên @OneToMany xử lý xóa groups/conditions cũ
rule.getGroups().clear();
rule.getGroups().addAll(buildGroups(request.getGroups(), rule));

rule.getDisplayGroups().clear();
rule.getDisplayGroups().addAll(buildDisplayGroups(request.getDisplayGroups(), rule));
```

🔑 **Vì sao `clear()` + `addAll()` chứ không `setGroups(newList)`?**
Hibernate theo dõi **chính đối tượng collection** để biết cần DELETE gì. Gán list mới (`setGroups`) làm mất tracking → `orphanRemoval` không chạy → `A collection with cascade="all-delete-orphan" was no longer referenced`.

⚠️ **Hệ quả nghiệp vụ của "xoá rồi tạo lại":** `rule_condition.id` **đổi** sau mỗi lần update. Mà `t_user_rule_progress.condition_id` trỏ tới id đó ⇒ **tiến độ của user bị mồ côi**, coi như reset.
→ Đây là đánh đổi phải biết: sửa nhiệm vụ đang chạy = reset tiến độ.

### `delete()` — chặn nếu là tiền đề của nhiệm vụ khác
```java
if (displayConditionRepository.existsByRequiredEarnRuleId(id)) {
    throw new ValidationException("Không thể xoá: nhiệm vụ đang là điều kiện hiển thị (tiền đề) của nhiệm vụ khác");
}
```
🔑 Không có FK constraint ở DB (vì `required_earn_rule_id` chỉ là cột UUID thường) → phải chặn ở tầng ứng dụng, tránh mission con **mồ côi** (không bao giờ hiển thị được).

---

## 6. 🔑 `RuleValidationServiceImpl` — validate cấu trúc biểu thức

### Quy tắc cho `groups`

```java
private void validateGroupOperator(ConditionGroupRequest group, boolean isLast, int idx) {
    if (isLast && group.getNextOperator() != null)
        throw new ValidationException("Group cuối (index " + idx + ") phải có nextOperator = null");
    if (!isLast && (group.getNextOperator() == null || !VALID_NEXT_OPERATORS.contains(...)))
        throw new ValidationException("Group " + idx + " phải có nextOperator là AND hoặc OR");
}
```
🔑 Phần tử **cuối** phải `null`, phần tử **không cuối** phải có AND/OR. Ràng buộc này đảm bảo biểu thức **luôn well-formed** — engine không phải phòng thủ.

### Quy tắc cho từng `condition`
| Kiểm tra | Điều kiện |
|---|---|
| `nextOperator` | như trên |
| `triggerEventType` | phải nằm trong `eventTypeCacheService.getActiveEventCodes()` (cache 5') |
| `ruleType` | bắt buộc, ∈ {COUNT, SUM, STREAK} |
| `sumField` | **bắt buộc khi `ruleType = SUM`** |
| `value` | không rỗng, phải là **số nguyên dương** |
| `value` với `IN`/`NOT_IN` | tách theo `,`, **mỗi phần** phải là số nguyên dương |
| `valueTo` với `BETWEEN` | bắt buộc, phải **> `value`** |

```java
private int parsePositiveInt(String s, String fieldLabel) {
    try {
        int v = Integer.parseInt(s);
        if (v < 1) throw new ValidationException(fieldLabel + " phải lớn hơn 0, nhận: " + s);
        return v;
    } catch (NumberFormatException e) {
        throw new ValidationException(fieldLabel + " phải là số nguyên dương, nhận: '" + s + "'");
    }
}
```
🔑 Message lỗi **kèm giá trị nhận được** và **vị trí** (`"Condition 2 trong group 1: value ..."`) → admin sửa được ngay, không phải đoán.

### 🔑 Chống chu trình phụ thuộc (DFS)

```java
@Override
public void validateDisplayGroups(List<DisplayGroupRequest> displayGroups, UUID earnRuleId) {
    if (displayGroups == null || displayGroups.isEmpty()) return;     // rỗng = hiển thị cho tất cả

    Set<UUID> directPrereqs = new HashSet<>();
    for (...) { validateDisplayGroupOperator(...); validateDisplayConditions(..., directPrereqs); }

    // Chu trình chỉ có thể xảy ra khi UPDATE: earnRuleId đã tồn tại và có thể đang bị rule khác
    // tham chiếu. Khi CREATE (earnRuleId == null) rule chưa tồn tại nên không ai phụ thuộc vào nó.
    if (earnRuleId != null) {
        for (UUID prereq : directPrereqs) {
            if (reachesTarget(prereq, earnRuleId, new HashSet<>()))
                throw new ValidationException("Điều kiện hiển thị tạo chu trình phụ thuộc: ...");
        }
    }
}

/** DFS theo các cạnh requiredEarnRuleId đang có trong DB. */
private boolean reachesTarget(UUID start, UUID target, Set<UUID> visited) {
    if (start.equals(target)) return true;
    if (!visited.add(start)) return false;                   // 🔑 chống lặp vô hạn
    for (UUID next : displayConditionRepository.findRequiredEarnRuleIdsByEarnRuleId(start))
        if (reachesTarget(next, target, visited)) return true;
    return false;
}
```

💡 **Đây là bài toán "phát hiện chu trình trong đồ thị có hướng"**.
Nếu A cần B, B cần C, mà giờ set C cần A → chu trình → **cả 3 nhiệm vụ không bao giờ hiển thị được cho ai** (bế tắc vĩnh viễn).
`visited` bắt buộc phải có — nếu không, chu trình đã tồn tại trong DB sẽ làm DFS chạy vô hạn (StackOverflow).

Các kiểm tra khác của display condition:
- `requiredEarnRuleId` không được `null`
- **không được là chính nó** (`required.equals(earnRuleId)`)
- earn_rule tiền đề **phải tồn tại** (`existsById`)

---

## 7. `EarnRuleQueryServiceImpl` — đọc

### `getOptions()` — dữ liệu dựng form admin
```java
return RuleOptionsResponse.builder()
        .eventTypes(eventTypeCacheService.getEventTypeOptions())    // từ cache Redis
        .ruleTypes(enumNames(RuleType.class))
        .streakUnits(enumNames(StreakUnit.class))
        .filterOperators(enumNames(OperatorCode.class))
        .categories(enumNames(MissionCategory.class))
        .resetPeriods(enumNames(ResetPeriod.class))
        .missions(earnRuleRepository.findAll()...)                  // để chọn tiền đề
        .routers(appRouterService.getActiveRouters())
        .build();

private <E extends Enum<E>> List<String> enumNames(Class<E> enumClass) {
    return Arrays.stream(enumClass.getEnumConstants()).map(Enum::name).collect(Collectors.toList());
}
```
🔑 **1 API duy nhất** trả mọi dropdown → portal không phải gọi 8 API.
💡 `enumNames()` generic — enum thêm giá trị mới thì form tự có, không phải sửa code.

### Batch-load tên nhiệm vụ tiền đề (tránh N+1)
```java
Set<UUID> requiredIds = groups.stream().flatMap(g -> g.getConditions().stream())
        .map(DisplayConditionEntity::getRequiredEarnRuleId).collect(Collectors.toSet());
Map<UUID, String> nameById = earnRuleRepository.findAllById(requiredIds).stream()
        .collect(Collectors.toMap(EarnRuleEntity::getId, EarnRuleEntity::getName));
```
🔑 1 query `findAllById` thay vì N query `findById` trong vòng lặp. Pattern này lặp lại khắp service.

---

## 8. `event_type` — từ vựng dùng chung

```java
@Entity @Table(name = "event_type")
public class EventTypeEntity {
    UUID id; String code;       // 🔑 code này phải KHỚP behavior_type bên behavior-events
    String name; EventTypeCategory type; DataType dataType; Boolean isActive; Integer sortOrder;
}
```

### ⚠️ Bài học SB-4815 (V055) — đối chiếu từ vựng giữa 2 repo

`CHANGELOG.md` ghi lại:
> *"Đo trên UAT: giao điểm giữa 2 bên trước đó **chỉ có `DAILY_LOGIN`** — app đang bắn `APP_APPLIED`/`APP_CLICK_APPLY`/`APP_VIEW_JOB`/... nhưng `event_type` **không có code nào** trong số đó, trong khi `APPLY` (đã seed) thì **không ai phát**."*

**Vì sao không đổi tên bên behavior-events cho khớp?**
> *"CDP feature khoá theo chính `behavior_type` (`customer_feature_definition.source_filter`) — rename là **làm chết feature/segment đang chạy trên dữ liệu thật** (`APP_APPLIED` đã có 10 behavior, `APP_VIEW_CHECKIN` 110.616, `ATTENDANCE` 1.453.109)."*
→ Sửa chiều ngược lại: thêm 8 code `APP_*` vào `event_type`, xoá `APPLY`.

**Bẫy được ghi lại:**
> *"`APPLY`: có trong dropdown, **không ai phát** → nhiệm vụ đứng mãi ở `current_count = 0`"*
> *"10 code đã có trong `event_type` nhưng **chưa có producer**"*
> *"2 code `LOGIN`(9 condition)/`PURCHASE`(10) đang được rule trỏ tới nhưng **không tồn tại** trong `event_type` → rule chết"*

💡 **Bài học tổng quát:** khi 2 hệ thống chia sẻ 1 từ vựng mà không có ràng buộc kỹ thuật nào (không FK, khác DB, khác repo), phải có **quy trình đối chiếu định kỳ** — nếu không sẽ trôi dạt âm thầm.

### `LogicOperatorEntity` — legacy
Bảng `logic_operator` map `event_type_code` → operator được phép. Cột `rule_condition.event_type_code` / `logic_operator_id` được đánh dấu **"Legacy filter columns (FK-constrained, kept for existing data)"** — không còn dùng ở luồng mới.

⚠️ Tương tự, các cột `filter_field` / `filter_operator` / `filter_value` / `filter_value_to` trong `rule_condition` **tồn tại nhưng `EarnRuleServiceImpl.buildConditions()` KHÔNG map chúng** → cấu hình filter bị bỏ qua âm thầm.
→ Chính vì thế `V004` bên behavior-events phải **tách 2 behaviorType** thay vì dùng 1 code + filter (xem [`../01-behavior-events/06-entity-database.md`](../01-behavior-events/06-entity-database.md)).

## 9. Đi tiếp

→ [`12-module-rule-engine.md`](12-module-rule-engine.md)
