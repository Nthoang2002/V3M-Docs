# customer-service — Module Rule Engine (tính điểm) 🔑

`service/rule/engine/impl/RuleEngineServiceImpl.java` — **765 dòng, class quan trọng nhất của service**.

---

## 1. Ba bảng trạng thái

| Bảng | Ý nghĩa |
|---|---|
| **`t_user_rule_progress`** | Tiến độ: 1 dòng cho mỗi `(user_id, condition_id, period_key)`. UNIQUE `uq_user_condition_period` |
| **`t_user_point`** | Tổng điểm hiện tại: 1 dòng / user (UNIQUE `user_id`) |
| **`t_point_transaction`** | Sổ cái: mỗi lần cộng/trừ điểm 1 dòng (`EARN` / `REDEEM` / `REFUND`) |

```java
@Table(name = "t_user_rule_progress",
       uniqueConstraints = @UniqueConstraint(name = "uq_user_condition_period",
                                             columnNames = {"user_id","condition_id","period_key"}))
public class UserRuleProgress {
    Long userId; UUID earnRuleId; UUID conditionId;
    String periodKey = "NONE";      // "NONE" | "2026-05-15" | "2026-W20" | "2026-05"
    Integer currentCount = 0;
    Boolean completed = false;  LocalDateTime completedAt;
    Boolean rewarded  = false;      // 🔑 đã cộng điểm cho kỳ này chưa
    LocalDate lastEventDate;        // cho STREAK
}
```

### 🔑 `periodKey` — khoá của cơ chế lặp lại

```java
String computePeriodKey(ResetPeriod resetPeriod, LocalDate date) {
    if (resetPeriod == null || resetPeriod == ResetPeriod.NONE) return "NONE";
    switch (resetPeriod) {
        case DAILY:   return date.toString();                          // "2026-05-15"
        case WEEKLY:  int week = date.get(IsoFields.WEEK_OF_WEEK_BASED_YEAR);
                      int year = date.get(IsoFields.WEEK_BASED_YEAR);
                      return year + "-W" + String.format("%02d", week); // "2026-W20"
        case MONTHLY: return date.format(DateTimeFormatter.ofPattern("yyyy-MM"));  // "2026-05"
        default:      return "NONE";
    }
}
```
💡 `IsoFields.WEEK_BASED_YEAR` chứ không `date.getYear()`: tuần cuối tháng 12 có thể thuộc **tuần 1 của năm sau** theo ISO-8601. Dùng `getYear()` sẽ sinh key sai ở đúng chỗ chuyển năm.

🔑 **Cơ chế**: nhiệm vụ DAILY thì mỗi ngày sinh `period_key` mới → dòng progress mới → user làm lại được. Không cần job reset gì cả — **thời gian tự sinh kỳ mới**.

---

## 2. 🔑 `processEvent()` — luồng chính

```java
@Override
@Transactional
public void processEvent(CustomerEvent event) {
    LocalDate today = event.getOccurredAt().toLocalDate();

    // (1) Tìm mọi condition đang lắng nghe event type này
    List<RuleConditionEntity> conditions = ruleConditionRepository
            .findActiveByTriggerEventType(event.getEventType(), RuleStatus.ACTIVE, today);
    if (conditions.isEmpty()) { log.debug("No active conditions for eventType={}", ...); return; }

    // (2) Gom theo earn_rule
    Map<UUID, List<RuleConditionEntity>> byEarnRule = conditions.stream()
            .collect(Collectors.groupingBy(rc -> rc.getGroup().getEarnRule().getId()));

    // (3) Xử lý từng earn_rule ĐỘC LẬP
    for (Map.Entry<UUID, List<RuleConditionEntity>> entry : byEarnRule.entrySet()) {
        try {
            processEarnRule(event, entry.getValue().get(0).getGroup().getEarnRule(), entry.getValue(), today);
        } catch (Exception e) {
            log.error("processEarnRule failed: userId={}, earnRuleId={}, debug={}", ...);   // 🔑 nuốt
        }
    }
}
```

🔑 **`try/catch` trong vòng lặp** — 1 nhiệm vụ lỗi không chặn các nhiệm vụ khác của cùng event.
⚠️ Nhưng cả method là `@Transactional` — exception bị bắt nên transaction **không** rollback, phần đã ghi vẫn commit. Đây là hành vi mong muốn ở đây (mỗi rule độc lập).

### Query nạp condition (`JOIN FETCH` chống N+1)
```java
@Query("SELECT rc FROM RuleConditionEntity rc " +
       "JOIN FETCH rc.group g " +
       "JOIN FETCH g.earnRule er " +
       "WHERE rc.triggerEventType = :eventType " +
       "AND er.status = :status " +
       "AND (er.startDate IS NULL OR er.startDate <= :today) " +
       "AND (er.endDate   IS NULL OR er.endDate   >= :today)")
List<RuleConditionEntity> findActiveByTriggerEventType(...);
```
🔑 `JOIN FETCH` nạp sẵn `group` và `earnRule` trong **1 query**. Không có nó, mỗi lần `rc.getGroup().getEarnRule()` sẽ bắn thêm 2 query (LAZY) → N+1.

---

## 3. `processEarnRule()` — 3 cổng chặn

```java
private void processEarnRule(CustomerEvent event, EarnRuleEntity earnRule,
                             List<RuleConditionEntity> matchingConditions, LocalDate today) {
    // ── CỔNG 1: user đã enroll nhiệm vụ này chưa ─────────────────────────
    if (!userRuleProgressRepository.existsByUserIdAndEarnRuleId(event.getUserId(), earnRule.getId())) {
        log.debug("userId={} chưa accept earnRuleId={}, skip", ...);
        return;                                        // ⚠️ event bị BỎ
    }

    // ── CỔNG 2: đã thưởng trong kỳ này chưa ──────────────────────────────
    String periodKey = computePeriodKey(earnRule.getResetPeriod(), today);
    List<UserRuleProgress> periodProgress = userRuleProgressRepository
            .findAllByUserIdAndEarnRuleIdAndPeriodKey(event.getUserId(), earnRule.getId(), periodKey);
    if (periodProgress.stream().anyMatch(p -> Boolean.TRUE.equals(p.getRewarded()))) {
        log.debug("earnRuleId={} already rewarded for userId={} period={}", ...);
        return;
    }

    // ── Cập nhật tiến độ từng condition ──────────────────────────────────
    boolean anyConditionUpdated = false;
    for (RuleConditionEntity condition : matchingConditions)
        if (processCondition(event, earnRule, condition, periodKey)) anyConditionUpdated = true;

    // ── CỔNG 3: chỉ đánh giá hoàn thành khi CÓ thay đổi ──────────────────
    if (anyConditionUpdated) checkAndAwardEarnRule(event.getUserId(), earnRule, periodKey);
}
```

🔑 **Cổng 1 là gốc rễ của toàn bộ cơ chế auto-enroll** (mục 6). Chưa có dòng `t_user_rule_progress` nào ⇒ **mọi event bị bỏ**, âm thầm.

🔑 **Cổng 3** tránh chạy `checkAndAwardEarnRule` (nạp toàn bộ condition + progress) một cách vô ích khi không có gì đổi.

---

## 4. `processCondition()` — 3 kiểu tính tiến độ

```java
private boolean processCondition(CustomerEvent event, EarnRuleEntity earnRule,
                                 RuleConditionEntity condition, String periodKey) {
    UserRuleProgress progress = userRuleProgressRepository
            .findByUserIdAndConditionIdAndPeriodKey(event.getUserId(), condition.getId(), periodKey)
            .orElseGet(() -> userRuleProgressRepository.save(UserRuleProgress.builder()...build()));

    if (Boolean.TRUE.equals(progress.getCompleted())) return false;      // đã xong, bỏ qua

    switch (condition.getRuleType() != null ? condition.getRuleType() : RuleType.COUNT) {
        case SUM:    if (!applySumDelta(event, condition, progress)) return false; break;
        case STREAK: if (!applyStreakIncrement(earnRule.getResetPeriod(), today, progress)) return false; break;
        case COUNT:
        default:     progress.setCurrentCount(progress.getCurrentCount() + 1); break;
    }

    if (isConditionMet(condition, progress.getCurrentCount())) markCompleted(progress);
    userRuleProgressRepository.save(progress);
    return true;
}
```

### `applySumDelta()` — cộng dồn giá trị từ metadata
```java
String sumField = condition.getSumField();
if (sumField == null || sumField.isBlank()) { log.warn("...ruleType=SUM but sumField is blank"); return false; }
Map<String, Object> metadata = event.getMetadata();
if (metadata == null || !metadata.containsKey(sumField)) { log.debug("...not in metadata, skip"); return false; }
int delta = parseNumericSafe(metadata.get(sumField), condition.getId());
if (delta <= 0) { log.debug("...delta not positive, skip"); return false; }
progress.setCurrentCount(progress.getCurrentCount() + delta);
```
🔑 Mọi nhánh bất thường đều **`return false`** (không tính) chứ không ném exception — event lạ không được làm hỏng cả luồng.

```java
private int parseNumericSafe(Object value, UUID conditionId) {
    try {
        if (value instanceof Number) return (int) Math.round(((Number) value).doubleValue());
        return Integer.parseInt(value.toString().trim());
    } catch (Exception e) { log.warn("...cannot parse as number"); return 0; }
}
```
💡 `Math.round(doubleValue())` — metadata JSON có thể là `8.5` (giờ làm). Làm tròn thay vì cast (cast `(int) 8.9` = 8, làm tròn = 9).

### 🔑 `applyStreakIncrement()` — chuỗi liên tiếp
```java
private boolean applyStreakIncrement(ResetPeriod resetPeriod, LocalDate today, UserRuleProgress progress) {
    LocalDate lastEventDate = progress.getLastEventDate();
    if (lastEventDate == null) {                       // lần đầu
        progress.setCurrentCount(1); progress.setLastEventDate(today); return true;
    }
    if (isSamePeriod(lastEventDate, today, resetPeriod)) return false;      // 🔑 CÙNG kỳ → KHÔNG tăng
    if (isConsecutivePeriod(lastEventDate, today, resetPeriod))
        progress.setCurrentCount(progress.getCurrentCount() + 1);           // liền kề → +1
    else
        progress.setCurrentCount(1);                                        // 🔑 ĐỨT → reset về 1
    progress.setLastEventDate(today);
    return true;
}
```

🔑 **Ba trạng thái, ba xử lý khác nhau:**
| Tình huống | Xử lý |
|---|---|
| Cùng kỳ (đăng nhập 2 lần trong 1 ngày) | **Không tăng** — 1 kỳ chỉ tính 1 |
| Kỳ liền kề (hôm qua → hôm nay) | `+1` |
| Cách quãng (nghỉ 1 ngày) | **Reset về 1** — không phải 0, vì hôm nay vẫn tính |

```java
boolean isConsecutivePeriod(LocalDate lastDate, LocalDate today, ResetPeriod rp) {
    switch (rp) {
        case DAILY: return today.equals(lastDate.plusDays(1));
        case WEEKLY: {
            LocalDate startOfThisWeek = today.with(DayOfWeek.MONDAY);
            LocalDate startOfPrevWeek = startOfThisWeek.minusWeeks(1);
            return !lastDate.isBefore(startOfPrevWeek) && lastDate.isBefore(startOfThisWeek);
        }
        case MONTHLY: {
            LocalDate startOfThisMonth = today.withDayOfMonth(1);
            return !lastDate.isBefore(startOfThisMonth.minusMonths(1)) && lastDate.isBefore(startOfThisMonth);
        }
    }
}
```
💡 WEEKLY/MONTHLY dùng **khoảng [đầu kỳ trước, đầu kỳ này)** chứ không `plusWeeks(1)` — vì "tuần trước" là cả tuần, không phải đúng 7 ngày trước.

### `isConditionMet()` — so `currentCount` với `value`
```java
if (op == null) return count >= parseIntSafe(value, ...);          // mặc định >=
switch (op) {
    case EQ: return count == ...;   case NEQ: return count != ...;
    case GT: return count >  ...;   case GTE: return count >= ...;
    case LT: return count <  ...;   case LTE: return count <= ...;
    case BETWEEN: return count >= parseIntSafe(value) && count <= parseIntSafe(valueTo);
    case IN:     return Arrays.stream(value.split(",")).map(String::trim).anyMatch(v -> v.equals(String.valueOf(count)));
    case NOT_IN: return Arrays.stream(value.split(",")).map(String::trim).noneMatch(...);
    default:     return count >= parseIntSafe(value, ...);
}
```
⚠️ Ở đây dùng `condition.getFilterOperator()` để so **currentCount** — trùng tên với "filter metadata" nhưng ngữ nghĩa khác. Đây là điểm dễ nhầm khi đọc code.
```java
private int parseIntSafe(String value, UUID conditionId) {
    try { return Integer.parseInt(value.trim()); }
    catch (Exception e) { log.warn("conditionId={} value='{}' không parse được, dùng default=1", ...); return 1; }
}
```
💡 Fallback `1` (không phải 0) — 0 sẽ khiến điều kiện `>=0` **luôn đúng** ⇒ thưởng ngay lập tức. `1` an toàn hơn.

---

## 5. `isEarnRuleComplete()` — đánh giá biểu thức AND/OR

```java
private boolean isEarnRuleComplete(List<RuleConditionGroupEntity> groups,
                                   List<RuleConditionEntity> allConditions,
                                   Map<UUID, Boolean> completionMap) {
    if (groups.isEmpty()) return false;

    Map<UUID, List<RuleConditionEntity>> byGroup = allConditions.stream()
            .collect(Collectors.groupingBy(rc -> rc.getGroup().getId()));
    List<RuleConditionGroupEntity> sortedGroups = groups.stream()
            .sorted(Comparator.comparingInt(g -> g.getSortOrder() != null ? g.getSortOrder() : 0))
            .collect(Collectors.toList());

    boolean result = evaluateGroup(sortedGroups.get(0), byGroup, completionMap);
    for (int i = 0; i < sortedGroups.size() - 1; i++) {
        boolean nextResult = evaluateGroup(sortedGroups.get(i + 1), byGroup, completionMap);
        if (sortedGroups.get(i).getNextOperator() == LogicalOperator.OR) result = result || nextResult;
        else                                                             result = result && nextResult;
    }
    return result;
}
```

⚠️ **Đánh giá TUẦN TỰ, KHÔNG có độ ưu tiên toán tử.**
`A AND B OR C` → `((A AND B) OR C)`.
`A OR B AND C` → `((A OR B) AND C)` — **không phải** `A OR (B AND C)` như toán học.

💡 Đây là đơn giản hoá có chủ ý: admin không phải nhập ngoặc, và cấu trúc 2 tầng (group / condition) đã cho đủ khả năng biểu đạt cho hầu hết nhiệm vụ. Nhưng **phải nhớ** khi cấu hình rule phức tạp.

⚠️ Cũng lưu ý: không có **short-circuit** — `evaluateGroup` được gọi cho mọi group kể cả khi `result` đã xác định. Không sai (thuần đọc từ `Map`), chỉ hơi thừa.

`evaluateGroup()` làm y hệt ở tầng condition, dùng `completionMap.getOrDefault(condId, false)`.

---

## 6. 🔑 Auto-enroll (SB-4815) — 3 đường vào

**Vấn đề gốc:** Cổng 1 của `processEarnRule` yêu cầu phải có dòng `t_user_rule_progress`. Trước SB-4815 chỉ có 1 cách tạo: user **bấm "Nhận nhiệm vụ"**. Không bấm = event bị bỏ, user không hiểu vì sao không được điểm.

### Ba nguồn tạo progress (tag `source` trong metric)

| `source` | Khi nào | Ở đâu |
|---|---|---|
| `accept` | User bấm "Nhận nhiệm vụ" | `acceptMission()` |
| `lazy` | User mở app, gọi `GET /missions` | `getAvailableMissions()` — 🔑 **endpoint GET có GHI DB** |
| `unlock` | User vừa hoàn thành nhiệm vụ tiền đề | `enrollUnlockedMissions()` sau `awardPoints()` |

### `acceptMission()` — nay **idempotent**
```java
// SB-4815: từ khi user đủ điều kiện hiển thị là progress đã được tạo tự động (lazy + push khi mở khoá)
// → endpoint này thành idempotent, KHÔNG ném lỗi nữa.
// Trước đây ném "Đã nhận nhiệm vụ này rồi" sẽ làm nút "Nhận" trên app LUÔN báo lỗi.
if (userRuleProgressRepository.existsByUserIdAndEarnRuleId(userId, earnRuleId)) {
    log.info("acceptMission no-op (đã có progress): ..."); return;
}

// SB-4386: chặn nhận nếu chưa thoả điều kiện hiển thị — GATE SERVER-SIDE,
// không tin client đã ẩn mission, vì user vẫn có thể gọi accept trực tiếp theo ID.
List<DisplayConditionGroupEntity> displayGroups = displayConditionGroupRepository
        .findAllWithConditionsByEarnRuleIds(Collections.singletonList(earnRuleId));
if (!displayGroups.isEmpty() && !isMissionVisible(displayGroups, rewardedEarnRuleIds(userId)))
    throw new IllegalStateException("Chưa đủ điều kiện mở khoá nhiệm vụ: " + earnRuleId);
```
🔑 **Không tin client** — client ẩn nút không có nghĩa là user không gọi được API.

### `getAvailableMissions()` — GET nhưng `@Transactional` (ghi DB)
```java
@Override
@Transactional                        // 🔑 không readOnly — có INSERT
public List<AppMissionResponse> getAvailableMissions(Long userId, String routerCode) {
    List<EarnRuleEntity> allEligible = earnRuleRepository.findAllEligible(LocalDate.now());
    // lọc theo routerCode; mission chưa gắn router LUÔN được trả về (app cũ không mất nhiệm vụ)
    ...
    // Gom lazyRows cho MỌI mission visible chưa có progress
    List<MissionEnrollmentService.Row> lazyRows = new ArrayList<>();
    for (EarnRuleEntity er : visible) {
        if (subscribedEarnRuleIds.contains(er.getId())) continue;
        List<RuleConditionEntity> conditions = conditionsByEarnRule.getOrDefault(er.getId(), emptyList());
        if (conditions.isEmpty()) { log.warn("Bỏ qua auto-enroll: earnRuleId={} không có condition nào", ...); continue; }
        lazyRows.addAll(toRows(er.getId(), conditions, computePeriodKey(er.getResetPeriod(), today)));
        subscribedEarnRuleIds.add(er.getId());
    }
    // 🔑 Gom MỌI nhiệm vụ vào 1 statement
    if (!lazyRows.isEmpty()) enrollmentService.enrollAll(userId, lazyRows, "lazy");
    ...
}
```
Comment giải thích:
> *"Chỉ tạo cho mission **CHƯA có bản ghi nào (mọi kỳ)**: đó đúng là điều kiện `processEarnRule` dùng. Các kỳ sau `processCondition` tự tạo dòng mới khi có event, nên không ghi thêm ở đây để **tránh phình bảng theo mỗi lần mở app**."*

### `enrollUnlockedMissions()` — push khi mở khoá
```java
private void enrollUnlockedMissions(Long userId, UUID justRewardedEarnRuleId) {
    List<UUID> dependentIds = displayConditionRepository.findEarnRuleIdsByRequiredEarnRuleId(justRewardedEarnRuleId);
    ...
    for (UUID dependentId : dependentIds) {
        if (userRuleProgressRepository.existsByUserIdAndEarnRuleId(userId, dependentId)) continue;
        EarnRuleEntity dependent = earnRuleRepository.findById(dependentId).orElse(null);
        if (dependent == null || !isEnrollable(dependent, today)) continue;
        if (!isMissionVisible(displayGroupsByEarnRule.getOrDefault(dependentId, emptyList()), rewarded)) continue;
        ...
        enrollMission(userId, dependentId, conditions, computePeriodKey(...), "unlock");
    }
}
```
> *"sau khi user hoàn thành 1 nhiệm vụ, các nhiệm vụ lấy nó làm tiền đề có thể vừa đủ điều kiện hiển thị → tạo luôn progress để **event xảy ra NGAY SAU ĐÓ được tính**, không phải chờ user mở app (nhánh lazy chỉ là **lưới an toàn**)."*

---

## 7. 🔑🔑 `MissionEnrollmentService` — 4 failure đã reproduce thật

**Đây là class đáng học nhất trong toàn bộ codebase.** Javadoc ghi lại 4 quyết định, mỗi cái đến từ 1 sự cố **đo được trên UAT**.

```java
private static final String SQL_PREFIX =
        "INSERT INTO t_user_rule_progress (user_id, earn_rule_id, condition_id, period_key) VALUES ";
private static final String SQL_SUFFIX = " ON DUPLICATE KEY UPDATE id = id";

public boolean enrollAll(Long userId, List<Row> rows, String source) {
    List<Row> ordered = rows.stream()
            .sorted(Comparator.comparing((Row r) -> r.getConditionId().toString())
                    .thenComparing(Row::getPeriodKey))                        // (3)
            .collect(Collectors.toList());

    String sql = SQL_PREFIX + ordered.stream().map(r -> "(?, ?, ?, ?)").collect(joining(", ")) + SQL_SUFFIX;

    int affected = jdbcTemplate.update(sql, (PreparedStatementSetter) ps -> {
        int idx = 1;
        for (Row row : ordered) {
            ps.setLong(idx++, userId);
            ps.setBytes(idx++, toBytes(row.getEarnRuleId()));     // 🔑 setBytes tường minh cho BINARY(16)
            ps.setBytes(idx++, toBytes(row.getConditionId()));
            ps.setString(idx++, row.getPeriodKey());
        }
    });
    boolean created = affected > 0;
    count(source, created ? "created" : "duplicate");        // metric mission.auto_enroll{source,result}
    return created;
}
```

### 🔑 Bốn quyết định

**(1) `ON DUPLICATE KEY UPDATE id = id` thay vì `saveAll` của JPA**
> *"`saveAll` ném `DataIntegrityViolationException` khi 2 request cùng insert (unique `uq_user_condition_period`); vì id là `IDENTITY`, INSERT chạy ngay và Hibernate **mark transaction rollback-only** → cả danh sách nhiệm vụ **500**. Trên UAT: **burst 8 request thì 7 cái 500**."*

`id = id` là no-op → MariaDB đếm **0 affected row** → phân biệt được `created` vs `duplicate`.

**(2) 1 statement cho CẢ request (mọi nhiệm vụ × condition gộp 1 câu)**
> *"Bản chạy 1 statement cho **mỗi nhiệm vụ** (15 lần) trong transaction riêng làm mỗi request giữ **2 connection × 15 lượt** → 16–24 request đồng thời **cạn Hikari pool** (mặc định 10): `HikariPool-1 - Connection is not available, request timed out after 30000ms`."*

**(3) Sắp thứ tự row theo `(condition_id, period_key)`**
> *"mọi request khoá unique index **cùng chiều**. Bản không sắp bị `DeadlockLoserDataAccessException` khi burst."*

💡 Deadlock xảy ra khi 2 transaction khoá cùng tập hàng theo **thứ tự ngược nhau**. Sắp xếp trước khi ghi = mọi transaction đi cùng một chiều = không thể ôm khoá chéo.

**(4) KHÔNG dùng `REQUIRES_NEW`**
> *"transaction riêng **luôn cần connection thứ 2**, chính là nguyên nhân cạn pool ở trên. Chạy trong transaction của caller thì mỗi request chỉ **1 connection**, và enroll ở nhánh unlock **rollback cùng** việc cộng điểm nếu luồng đó fail (đúng hơn bản cũ: tx riêng vẫn commit enroll dù điểm đã rollback)."*

### Kết quả đo
> *"8/16/24/32 request song song đều **200**, đúng **21 dòng**, **0 exception**."*

### Vì sao KHÔNG bắt exception
> *"Deadlock vẫn còn khả năng lý thuyết; nếu xảy ra thì request đó 500 và **request kế tiếp thành công vì dòng đã tồn tại** — KHÔNG bắt exception ở đây vì **trong cùng transaction, catch không cứu được** (tx đã rollback-only)."*

💡 **Bài học lớn nhất:** khi transaction đã bị đánh dấu rollback-only, `try/catch` chỉ che lỗi chứ không cứu được gì — commit vẫn sẽ fail.

### `setBytes` tường minh
```java
// PreparedStatementSetter thay vì varargs Object[]: setBytes tường minh cho cột binary(16),
// không để driver tự suy kiểu từ byte[].
private static byte[] toBytes(UUID uuid) {
    return ByteBuffer.allocate(16).putLong(uuid.getMostSignificantBits())
                                  .putLong(uuid.getLeastSignificantBits()).array();
}
```

---

## 8. `awardPoints()` — cộng điểm

```java
private void awardPoints(Long userId, EarnRuleEntity earnRule, String periodKey) {
    UserPoint userPoint = userPointRepository.findByUserId(userId)
            .orElseGet(() -> UserPoint.builder().userId(userId).build());
    userPoint.setTotalPoints(userPoint.getTotalPoints() + earnRule.getPoint());
    userPoint.setLastUpdatedAt(LocalDateTime.now());
    userPointRepository.save(userPoint);

    pointTransactionRepository.save(PointTransaction.builder()
            .userId(userId).points(earnRule.getPoint()).type(TransactionType.EARN)
            .earnRuleId(earnRule.getId()).note("Hoàn thành nhiệm vụ: " + earnRule.getName()).build());

    // Đánh dấu tất cả condition progress trong kỳ này là rewarded
    List<UserRuleProgress> periodProgress = userRuleProgressRepository
            .findAllByUserIdAndEarnRuleIdAndPeriodKey(userId, earnRule.getId(), periodKey);
    periodProgress.forEach(p -> p.setRewarded(true));
    userRuleProgressRepository.saveAll(periodProgress);

    // 🔑 Hai việc phụ — best-effort, KHÔNG được làm mất điểm đã cộng
    try { notificationService.notifyMissionCompleted(userId, earnRule.getName(), earnRule.getPoint(),
                                                     userPoint.getTotalPoints(),
                                                     earnRule.getRouter() != null ? earnRule.getRouter().getPath() : null);
    } catch (Exception e) { log.warn("notifyMissionCompleted failed (không ảnh hưởng cộng điểm): ..."); }

    try { enrollUnlockedMissions(userId, earnRule.getId()); }
    catch (Exception e) { log.warn("enrollUnlockedMissions failed (không ảnh hưởng cộng điểm): ..."); }
}
```

🔑 **Hai lớp bảo vệ cho "việc phụ không làm hỏng việc chính":**
1. `try/catch` ở đây
2. `notifyMissionCompleted` khai `@Transactional(propagation = REQUIRES_NEW)` → transaction riêng, rollback nó không kéo theo transaction cộng điểm

⚠️ **Không có khoá pessimistic ở `awardPoints`** — khác `GiftRedemptionTxService.reserve()` (dùng `findByUserIdForUpdate`). Lý do: 2 event của cùng user tới đồng thời rất hiếm, và đã có dedup Redis theo phút chặn phần lớn. Đây là đánh đổi có ý thức (comment ở repository ghi rõ *"Không đổi `findByUserId` (dùng ở awardPoints/rule engine) để tránh ảnh hưởng luồng khác ngoài phạm vi"*).

---

## 9. Điều kiện hiển thị — `isMissionVisible()`

```java
private boolean isMissionVisible(List<DisplayConditionGroupEntity> displayGroups, Set<UUID> rewardedEarnRuleIds) {
    if (displayGroups == null || displayGroups.isEmpty()) return true;    // 🔑 rỗng = hiện cho tất cả
    ... // đánh giá AND/OR tuần tự y hệt isEarnRuleComplete
}
private boolean evaluateDisplayGroup(DisplayConditionGroupEntity group, Set<UUID> rewardedEarnRuleIds) {
    ...
    boolean result = rewardedEarnRuleIds.contains(conditions.get(0).getRequiredEarnRuleId());
    ...
}
```
`rewardedEarnRuleIds` = các earn_rule user đã `rewarded` **ít nhất 1 kỳ**.

Batch-load display group tránh N+1:
```java
@Query("SELECT DISTINCT g FROM DisplayConditionGroupEntity g " +
       "JOIN FETCH g.earnRule er LEFT JOIN FETCH g.conditions " +
       "WHERE er.id IN :earnRuleIds")
List<DisplayConditionGroupEntity> findAllWithConditionsByEarnRuleIds(Collection<UUID> earnRuleIds);
```
💡 `LEFT JOIN FETCH` cho `conditions` — group không có condition nào vẫn được trả về (`INNER JOIN` sẽ loại mất).

---

## 10. API cho app (`AppMissionController`, base `/missions`)

| Method | Path | Mô tả |
|---|---|---|
| GET | `/missions?routerCode=` | 🔑 Danh sách nhiệm vụ + tiến độ. **Endpoint này GHI DB** (auto-enroll) |
| POST | `/missions/{earnRuleId}/accept` | Nhận nhiệm vụ (idempotent) |
| GET | `/missions/points` | Tổng điểm |
| GET | `/missions/points/history?direction=` | Lịch sử điểm — `ALL` / `EARNED` (≥0, gồm REFUND) / `SPENT` (<0) |

### `getPointHistory()` — enrich tên quà có điều kiện
```java
// Chỉ load cache Urbox NẾU trang này thực sự có transaction liên quan tới quà (REDEEM/REFUND)
Map<String, String> giftTitleByGiftId = page.getContent().stream().anyMatch(tx -> tx.getGiftId() != null)
        ? giftCacheService.getGifts().stream()
                .collect(Collectors.toMap(UrboxGiftItem::getId, UrboxGiftItem::getTitle, (a, b) -> a))
        : Collections.emptyMap();
```
🔑 Trang chỉ toàn `EARN` → **không đọc cache quà**. Tối ưu nhỏ nhưng đúng nguyên tắc "chỉ trả giá khi cần".
💡 `(a, b) -> a` — merge function bắt buộc cho `toMap` khi key có thể trùng, nếu không sẽ `IllegalStateException: Duplicate key`.

## 11. Đi tiếp

→ [`13-module-gift-urbox.md`](13-module-gift-urbox.md)
