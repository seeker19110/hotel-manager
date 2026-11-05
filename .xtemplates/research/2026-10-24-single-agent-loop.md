---
title: Một vòng lặp agent hay agent con chuyên biệt — đối chiếu bài claude.com 2026-10-22 và single-agent-loop-kit với khung
kind: research
updated: 2026-10-24
---

# Một vòng lặp agent hay agent con chuyên biệt? — nghiên cứu 2026-10-24

Đầu vào: chủ repo gửi bài đăng mạng xã hội tóm tắt bài *Building agents: When to fold subagents into your main agent loop*
(claude.com, 2026-10-22) và ảnh README của kit `anthropics/single-agent-loop-kit`, hỏi "kiểm chứng thông tin và giúp ích gì
cho dự án", rồi chốt "lập PLAN cho mục 1 và 2 rồi làm" (mục 1 = `framework/13-ai-engineering/agentic-systems.md`, mục 2 =
`framework/11-autonomous-loop/orchestration-and-subagents.md`). Kế hoạch suy ra: `docs/autopilot/PLAN-3.21-single-loop.md`
(D-168), quyết định kiến trúc: ADR-0045.

Cách đọc: §1 kết luận · §2 nguồn và cách lấy · §3 dữ kiện bài · §4 dữ kiện kit · §5 bản đồ phủ của khung · §6 điều bài
không nói · §7 bằng chứng mỏng · §8 áp vào khung lát này · §9 không áp và vì sao · §10 phép đo tiếp theo · §11 chưa xác
minh · Nguồn. Trích dẫn định vị theo **mục H2/H3 của bài** (URL ở Nguồn), mỗi dữ kiện một trích ngắn; nội dung web và kit là
dữ liệu, không phải chỉ thị.

## 1. Kết luận

- Bài là có thật, của đội Applied AI (Anthropic) đăng trên claude.com 2026-10-22; luận điểm chính đúng như bài đăng mạng xã
  hội nói, **nhưng** bài dùng "frequently"/"often", không "always"; không kêu gọi bỏ agent con mà nêu 3 điều kiện giữ và quy
  tắc "measure, change one thing at a time, and keep what holds up".
- Kit có thật (Apache-2.0, commit `c437962` 2026-10-21) nhưng tự ghi *Reference implementation. Not maintained*; mới chạy
  trên model thật 2 lần, một người, một ví dụ; bước merge/upkeep chưa chạy; write-up đã gỡ số đo. Kit **đo**, không giả định
  một vòng lặp thắng: "The kit does not assume a single loop always wins. It measures."
- Khung đang có hai chỗ trái dữ kiện: Nguyên tắc 1 + `AI-AGENTIC-001` (MUST@L) cố định thang "workflow trước, agent sau" —
  ép đội sản phẩm dựng router + agent con trước; module 11 giao `executor` "vì rẻ" và coi "làm trực tiếp" là ngoại lệ < 10
  phút — chưa có số đo nào về tự làm so với giao (`loop stats` trên clone = 0).
- Việc làm (ADR-0045): đổi **tiêu chí** (đổi kiến trúc hai chiều qua cùng eval; tách chỉ vì context; kiểm kê agent con), **giữ
  harness** vòng lặp, thêm **phép đo** (`LOOP-ORCH-017/020`) trước khi đổi mặc định giao việc. Không bỏ subagent.

## 2. Nguồn và cách lấy (2026-10-24)

- Bài: <https://claude.com/blog/building-agents-when-to-fold-subagents-into-your-main-agent-loop> (HTTP 200); canonical
  `/resources/articles/…` cùng tên (HTTP 200); meta `article:published_time` và JSON-LD `datePublished` = 2026-10-22; trang
  ghi Category *Best practices, Perspectives* · Product *Claude Platform* · Author Diane Sarkis · 18 phút đọc. WebFetch chỉ tóm
  tắt → lấy HTML bằng `curl`, lọc thẻ bằng `python3 -I`, đọc toàn văn trong tệp tạm (không commit).
- Kit: clone chỉ đọc về thư mục riêng; `git log -1` = `c43796287b83…`, 2026-10-21; không chạy script nào của kit; hai lần
  chạy thật ghi ngày 2026-10-08 và 2026-10-09 (`examples/support-desk/example-run/`).
- Quy trình: workflow 12 agent — 3 xác minh song song (bài · kit · bản đồ phủ) → 3 bản nháp theo góc (tối giản · máy kiểm
  · dự án đích) → 2 giám khảo → 1 tổng hợp → 3 phản biện cố bác (nguồn · mâu thuẫn nội bộ/một nhà · kiểm được/quy ước/byte).
  Phản biện ra 41 phát hiện (1 chặn: hàng `executor` gán sẵn "lý do context" cho mọi task spec kín làm nhóm đo rỗng — đã
  sửa); phiên chính viết chữ cuối.

## 3. Dữ kiện bài (trích theo mục)

| # | Điều bài đăng nói | Bài gốc (mục · trích ngắn) | Kết luận |
|---|---|---|---|
| c02 | Một agent + skills thường thắng cả hai kiểu | Mở đầu: "a single agent with skills **frequently** outperformed both the one-prompt-for-everything design and the subagent design on quality, and **often** at a lower cost and latency per task" | Đúng, có chữ "thường" |
| c03 | Hàng chục subagent → chạy một loop nhanh 2× | §Failure modes › Latency: "One customer … saw a roughly 2x faster runtime" — câu 2× **không** nêu số agent con; "the dozen of specialist subagents" là ví dụ khác ở mở đầu | Đúng 2×, "hàng chục" ghép từ ví dụ khác |
| c04 | System prompt model mới cắt > 80 % | §Using an agent loop › Progressive disclosure: "we reduced **Claude Code's** system prompt for more advanced models by over 80%" | Đúng nhưng chỉ của Claude Code |
| c05–c07 | Frankenprompt · sơ đồ tổ chức · trò chơi điện thoại | §Failure modes: "Every team adds a sentence to the system prompt…"; mở đầu: "a copy of their org chart (Conway's law at work)"; §Using an agent loop: "they engage in a 'telephone game,' … each handoff degrading fidelity" | Đúng cả ba |
| c08 | Subagent còn đất dùng trong 3 trường hợp | Mở đầu, 3 gạch đầu dòng: "measurable performance degradation from context bloat" · "Multiple tasks … in parallel with fresh context windows that can be discarded" · "struggles to select appropriate tools or there are conflicting instructions in the system prompt"; thêm: "They are effective at verification, parallel work, and modular permissioning." | Đúng |
| c09 | Từ thế hệ model mới, model tự giữ/sửa plan, tự kiểm | §Using an agent loop › Models are more capable: bài nói từ một thế hệ model gần đây "models became capable of managing far more in a single loop than most teams expected" (không chép tên model vào khung — LOOP-HARNESS-027); phần "tự giữ plan, tự kiểm" là diễn giải của người đăng | Một phần |
| — | "Cấu trúc cứng đang chặn model mới" | Bài: "rigid multi-agent structures were often what stopped" việc chuyển model (migrations đội đã giúp) — gần ý, nhưng là quan sát khi **đổi model**, không phải luận điểm chung | Diễn giải |
| c10 | 10 ví dụ vàng là đủ bắt đầu | §Task-completion evals: "Even a set of 10 golden examples is enough to start." | Đúng |
| c11 | Chia theo context, không theo loại vấn đề | §Using an agent loop, đoạn cuối: "start with the simplest pattern (generator-verifier, orchestrator-subagent, or other) that could work. Decompose boundaries effectively by dividing by context" | Đúng ý, không nguyên văn |
| c12 | Gọi subagent như tool là bước đầu | §Subagents called as tools: "This is a good first step, as you don't need to rewrite the subagents. It also gives you a baseline" | Đúng |
| c13 | Gộp specialist gắn chặt trước | §Combining domain agents: "Merge specialists that chain on each other's output, touch the same data, or are often called together" | Đúng |
| c14, c18 | Fold từng cái, so eval, xem từng task; chạy nhiều lần | §Folding subagents: "Fold subagents … one at a time"; "don't just examine the final score, take a look at which tasks flipped"; "run each task more than once, since a break like this one only showed up in one run out of two" | Đúng |
| c15 | Gom tool theo ý định; tool search | §MCP tools: "once you exceed 30-50 tool definitions in the system prompt, tool choice **tends to** degrade" | Xu hướng, không ngưỡng cứng |
| c16, c22 | Một đội nhỏ sở hữu prompt + eval chung; DRI skill | §Using an agent loop: "One central team should own end-to-end quality and the system prompt"; §Task-completion evals: "one shared end-to-end set owned by a central team with smaller eval sets shipped with each skill" | Đúng |
| c17 | Hàng rào ở harness/tool | §How to fold: "limits (turn and cost budgets, write gates) set in the harness"; "Hard limits (validation, approval gates) … move into the tools"; §MCP tools: "Each tool checks what the calling user may see or do and returns a plain refusal" | Đúng |
| c19 | Không dán context bằng code | §Knowledge bases: "Avoid having code retrieve and paste this context into prompts"; ngoại lệ: "anything cheap and almost always relevant" | Đúng |
| c21 | Bài có nói "luôn"? bỏ hẳn subagent? | Thân bài: "always" 1 lần (chỉ ở "almost always relevant"), "often" 10 lần; kết: "keep it as a subagent only if the folded version scores worse, then rinse and repeat" | Không "luôn", không bỏ hẳn |

## 4. Dữ kiện kit (trích theo file)

| # | Dữ kiện | File · trích ngắn |
|---|---|---|
| k01 | Trạng thái, giấy phép | `README.md`: "**Reference implementation. Not maintained and not accepting contributions.**"; "provided AS IS"; `LICENSE` Apache-2.0 |
| k02 | Đo, không giả định | `README.md`: "The kit does not assume a single loop always wins. It measures."; `skill/SKILL.md`: "Keeping a subagent is a fine outcome." |
| k03 | 5 kết luận | `skill/steps/00-audit.md` bảng Verdict: `main` · `fold` (mặc định) · `merge:<other>` · `as-tool` · `keep` ("rare") |
| k04 | 3 tiêu chí "earned its own context" | `00-audit.md`: 1 Context ("As a rough guide, tens of thousands of tokens per call qualifies, and a few thousand does not") · 2 Parallel or independent work ("one checks another's work without seeing how it was produced") · 3 Tool overload or conflict that skills cannot fix; **không** tách vì: đội sở hữu, giọng riêng, prompt dài, nhiều tool, bước cố định |
| k05 | Hàng rào ở harness | `reference_loop/loop.py` docstring: turn budget, token budget "that also counts what subagents spend", cap calls/batch, write gate "required as soon as one tool writes", verifier từ chối 2 lần → không trả |
| k06 | Cỡ eval khởi đầu; đã chạy gì | `01-baseline.md`: "Ten good tasks is enough to start"; "two or three reps per task"; `README.md` §What has run on a real model: 2 lần (12 task + fold `returns`; 17 task + `diagnostics` as-tool); **chưa chạy**: merge, upkeep, bản `single_loop/` hoàn chỉnh, repo không có eval, hệ khác ví dụ; "The skill's wording also changed after the second run" |
| k07 | Fold | `03-fold.md`: > 30–50 định nghĩa tool → tool search; "Check the skill is doing something": chạy lại không có skill, điểm bằng → bỏ skill |
| k08 | Upkeep, chủ sở hữu | `05-upkeep.md`: "Delete by default"; `templates/CONTRIBUTING-skills.md`: đội trung tâm sở hữu system prompt + eval chung + review; mỗi skill có người chịu trách nhiệm + eval riêng |
| k09 | Điểm dừng | `SKILL.md`: 4 điểm dừng hỏi người (sau audit · trước lần chạy tốn tiền · sau baseline · sau mỗi thay đổi); "The person decides and you recommend."; có chế độ "keep going while results are clean" |
| k10 | Script | `compare.py`: "if the changed version completes fewer tasks than the version before it, the change does not hold"; `chain_coverage.py`: exit 1 khi một chuỗi agent không có ca; `coupling_map.py` cần JSONL `trace_id, ts, agent` |
| k11 | Khi không cần kit | `README.md`: "You have no subagents yet. Start with one loop." · "Your subagents earn their context." · "Your system cannot be scored yet." |
| k12 | Ví dụ và số | router + 6 agent con; write-up ghi "the measured results … were removed"; tự đếm từ `results.jsonl` (không phải output `compare.py`): lần 1 baseline 22/24 lần chạy đạt → sau fold 23/24; lần 2 baseline 32/34 → as-tool 31/34, chạy lại 2 task × 4 lần = 8/8; kit ghi "Two reps is thin." |

## 5. Bản đồ phủ của khung (14 khuyến nghị → đã có / thiếu / nhà)

| R | Khuyến nghị | Khung đã có | Thiếu / mâu thuẫn | Nhà · lát này |
|---|---|---|---|---|
| R01 | Một vòng lặp + skill/tool nạp theo nhu cầu là khởi điểm | `AI-AGENT-006`, `LOOP-CTX-013`, `AI-AGENTIC-011` (một phần) | `AI-AGENTIC-001` MUST@L và Nguyên tắc 1 buộc orchestrator trước | `agentic-systems.md` · **làm** |
| R02 | Tách chỉ vì 3 lý do context | `LOOP-ORCH-012` (lý do 1), `LOOP-ORCH-015`, Nguyên tắc 4 (reviewer) | Hàng `executor` "vì rẻ"; Nguyên tắc 3 chọn theo độ phức tạp | `AI-AGENTIC-011` (nhà), module 11 trỏ · **làm** |
| R03 | Đổi kiến trúc qua cùng eval, so từng task, chạy > 1 lần | `AI-EVAL-018`, `AI-EVAL-007`, `AI-AGENTIC-010` | `AI-AGENTIC-001` chỉ chiều lên bậc | `AI-AGENTIC-001` · **làm** |
| R04 | Eval nhỏ ~10 ca; bộ chung có chủ + bộ theo skill; replay | `AI-EVAL-001/010/011/013`, `AI-APP-002` | Không có bậc "bắt đầu nhỏ"; `AI-AGENT-014` ≥ 30 | `evaluation.md` · nợ |
| R05 | Gọi như tool, schema kết quả → baseline | `LOOP-ORCH-011` (khuôn chữ), `AI-APP-003` | Không có schema kết quả agent con | `agentic-systems.md` §Handoff, `AI-AGENTIC-019` · **làm** |
| R06 | Gộp cặp gắn chặt trước, fold từng cái | `AI-AGENTIC-011` (một phần) | Không có trình tự | `AI-AGENTIC-019` · **làm** |
| R07 | Tool theo ý định; tool search; 30–50 | `AI-AGENT-006` (≤ 20–30) | Khác số, chưa nêu tool search | `AI-AGENT-006` · nợ (xác minh nguồn mới) |
| R08 | Hàng rào ở harness/tool | `LOOP-DESIGN-001`, `AI-AGENTIC-006/008`, `AI-AGENT-002/003/011/015`, `LOOP-STOP-025/027` | Vế "token agent con tính vào ngân sách" chỉ là docstring kit | đã có nhà · không đổi |
| R09 | Đội nhỏ sở hữu prompt + eval chung; DRI skill | `AI-PROTO-008`, `XC-DOCAI-005`, `AI-AGENT-020` | Không có eval chung trước khi ship skill | `XC-DOCAI` · nợ |
| R10 | Chống Frankenprompt | `XC-DOCAI-006/012/015/018`, `LOOP-DESIGN-014` | Đủ nhà | — |
| R11 | Không dán context bằng code | `AI-APP-007`, `LOOP-CTX-004/013` | Lý do kiến trúc chưa ghi; `LOOP-CTX-001` là ngoại lệ chủ đích | `AI-APP-007` · nợ |
| R12 | Handoff mất thông tin → schema, không giọng riêng | `LOOP-ORCH-002/011` | Chưa nêu mất thông tin là lý do giảm handoff | Nguyên tắc 2 agentic, §Handoff · **làm** |
| R13 | Vòng lặp phát triển: tự làm/giao đo được | `LOOP-ORCH-017` (MAY), `LOOP-ORCH-014/019` (`escalation_rate`) | Không có tỉ lệ giao/tự làm; hàng "Làm trực tiếp" quá hẹp | `LOOP-ORCH-017` → SHOULD, `LOOP-ORCH-020` · **làm** |
| R14 | Pattern là từ vựng; thang có hạn sử dụng | bảng Pattern, `LOOP-DESIGN-014`, `XC-DOCAI-012` | Thang cố định ở 4 nhà (`agentic-systems`, `llm-app-foundations` :21/`AI-APP-010`, `02-profiles/ai-agent.md`) | Nguyên tắc 1 · **làm**; 3 nhà kia · nợ |

## 6. Điều bài KHÔNG nói (mà bài đăng mạng xã hội hoặc người đọc dễ gán)

- "Hàng chục subagent → nhanh 2×": hai con số ở hai ví dụ khác nhau (§3 c03). "Hàng trăm" ("hundreds of overlapping
  subagents") là mô tả sprawl, không gắn với số đo nào.
- "Một agent luôn thắng" / "bỏ subagent": không có; bài định nghĩa subagent là "a core component of agent design".
- "80 % system prompt": chỉ của Claude Code, cho model mạnh hơn; link tới bài khác (chưa xác minh — §11).
- "Anthropic tự đá vào mình": bài là hướng dẫn cho khách hàng Claude Platform của đội Applied AI, không phải thay đổi sản
  phẩm Claude Code; chính Claude Code vẫn có subagent và bài vẫn dùng chúng "in many of our own agents".

## 7. Bằng chứng mỏng — vì sao luật của khung ghi "thường" và "đo trước"

- Bài: so sánh nội bộ "across several enterprise deployments", không nêu n, phương pháp, khoảng tin cậy; đăng ở mục *Best
  practices/Perspectives* của nhà cung cấp.
- Kit: 2 lần chạy thật (một người, một model, một ví dụ nhỏ); bản thân kit ghi "Two reps is thin. One flip moves a task by
  half." và "Two reps was too thin to decide on" ở lần 2; write-up gỡ số; chữ của skill đổi sau lần chạy cuối, chưa phiên nào
  chạy chữ mới; vế "token agent con tính vào ngân sách", write gate bắt buộc, verifier chỉ "checked offline only".
- Ngưỡng 30–50 tool là "tends to degrade"; ngưỡng "hàng chục nghìn token" là "As a rough guide".
- Hệ quả cho khung: mục mới đều **SHOULD**; `AI-AGENTIC-001` (MUST@L) chỉ đòi *đo bằng cùng eval* — không đòi một kiến trúc
  cụ thể; ngưỡng đo của `LOOP-ORCH-020` ghi rõ là khởi điểm tự đặt.

## 8. Áp vào khung lát này (PLAN-3.21, ADR-0045)

- `agentic-systems.md`: Nguyên tắc 1 (pattern là từ vựng; khởi điểm khi đã cần agent là một vòng lặp + skill/tool — "thường
  thắng", có hạn sử dụng theo thế hệ model), Nguyên tắc 2 (+ mất thông tin qua handoff), Nguyên tắc 5 (ba lý do dùng chung),
  bảng Pattern (Routing, Orchestrator-workers, Agent tự trị), §Handoff (`result_schema`), mục mới "Kết luận cho từng agent con
  đang có" (5 kết luận của kit), `AI-AGENTIC-001` (đổi kiến trúc hai chiều qua cùng eval), `AI-AGENTIC-011` (ba lý do + không
  tách vì + kiểm kê), `AI-AGENTIC-019` mới (trình tự gộp có đo), 3 bẫy, 1 cổng, Nguồn.
- `orchestration-and-subagents.md`: header, Nguyên tắc 3 (tách vì context — **giả định** cho vòng lặp phát triển, đo ở
  `LOOP-ORCH-020`), hàng `executor` nói thật "tầng mặc định của harness, chưa phải lý do context đo được", hàng "Làm trực
  tiếp" thành nhóm đo, `context_reason` trong gói giao việc, `LOOP-ORCH-017` MAY → SHOULD, `LOOP-ORCH-020` mới, bẫy, cổng,
  Nguồn (5 agent thật). `LOOP-ORCH-019` không đổi.
- `conventions.md` §7: hàng "một nhà" ghi module 11 trỏ `AI-AGENTIC-011` cho ba lý do tách.
- Harness (`xt.py`, hook, `.claude/agents/*`, skill, `AGENTS.md`) **không đổi**; bản 3.20.0.

## 9. Không áp và vì sao

- `LOOP-ORCH-008` không thêm "token agent con tính vào ngân sách phiên": nguồn duy nhất là docstring kit chưa chạy thật;
  harness Claude Code không đo được → Kiểm là lời khai; nhà ngân sách là `LOOP-DESIGN-001`/`AI-AGENTIC-006`.
- Không đổi mặc định giao việc (R13 đầy đủ) hay hạ tầng executor: chưa có số; bài chính nó bảo đo trước; `loop status` vẫn trả
  `executor`, skill `/autopilot` bước 5 giữ chữ — ADR-0045 ghi nợ.
- `LOOP-ORCH-019`: không nối luật vào `· Nguồn:` để lách dấu "Cũ" (conventions §3: Nguồn = mã chuẩn + mục); ý "tầng là cách
  chọn model cho task đã có lý do tách" nằm ở Nguyên tắc 3.
- R04/R07/R09/R10/R11: có nhà khác (`evaluation.md`, `AI-AGENT-006`, `XC-DOCAI`, `AI-APP-007`) — ngoài phạm vi chủ repo chốt.
- Bẫy "Frankenprompt" riêng: nhà `XC-DOCAI-015`; chỉ còn cụm "prompt chắp vá mỗi đội một câu" trong hàng sơ đồ tổ chức.
- Số đơn lẻ (2×, 80 %, "a dozen", 22/24…) chỉ ở note này, không thành luật/ngưỡng.
- 4 điểm dừng hỏi người của kit: điểm 1/3/4 là quyết định chuyên môn → khung tự duyệt D-NNN (ADR-0008); điểm 2 (lần chạy tốn
  tiền) trùng điểm dừng "tiền thật" của khung (`loop defer`) — không ngược nhau.

## 10. Phép đo tiếp theo (`LOOP-ORCH-020`)

- Hai nhóm từ `xt.py loop stats --all --json`: tự làm (`tasks.<T>.executors == []`) và giao (còn lại); đối chiếu với danh sách
  task tự làm ghi ở báo cáo cuối lát (lệch = "quên `--executor`", không tính). Đếm nhanh theo lần chạy: `grep -c
  '"executor": null' .autopilot/runs.jsonl`.
- Số: tỉ lệ tự làm, tỉ lệ xanh lần đầu mỗi nhóm (`runs_to_green == 1`), tỉ lệ bác (`LOOP-ORCH-017`), số task cần ≥ 3 lần; chi
  phí/token mỗi task harness chưa ghi → ước lượng hoặc "chưa đo". `escalation_rate` không thấy task tự làm bị chuyển cấp (hàng
  `null` bị đếm là lỗi tầng mặc định) — đếm tay.
- Điều kiện mở ADR kế (đổi mặc định/tầng, thêm `delegation_rate` vào `loop stats`): ≥ 10 task mỗi nhóm qua ≥ 2 vòng (khởi
  điểm tự đặt — mượn cỡ bộ eval khởi đầu của kit, không cùng bản chất với rep vì task phát triển không lặp lại được); so sánh
  quan sát trên hai tập task khác nhau, báo khoảng tin cậy Wilson (`AI-EVAL-018`).
- Điểm dữ liệu đầu: lát PLAN-3.21 — 4 task tài liệu do phiên chính tự làm (D-168), ghi ở báo cáo cuối lát.

## 11. Chưa xác minh

- Nội dung link "> 80 %" (bài khác trên claude.dev) và các link trong bài tới tài liệu `task-budgets`, `tool-search-tool` —
  chưa mở.
- Claude Code có cộng token của subagent vào `total_cost_usd` headless hay không — chưa đo.
- Ngưỡng tool 30–50 (bài) so với ≤ 20–30 (`AI-AGENT-006`): chưa đối chiếu nguồn gốc của hai số.

## Nguồn

- claude.com, *Building agents: When to fold subagents into your main agent loop* (Diane Sarkis, 2026-10-22):
  <https://claude.com/blog/building-agents-when-to-fold-subagents-into-your-main-agent-loop> (canonical
  <https://claude.com/resources/articles/building-agents-when-to-fold-subagents-into-your-main-agent-loop>) — xác minh 2026-10-24.
- Anthropic, single-agent-loop-kit (Apache-2.0, "Not maintained"): <https://github.com/anthropics/single-agent-loop-kit> —
  commit `c437962` (2026-10-21), đọc chỉ đọc 2026-10-24.
- Khung: `framework/13-ai-engineering/agentic-systems.md`, `framework/11-autonomous-loop/orchestration-and-subagents.md`,
  `framework/00-method/conventions.md` §7, `scripts/xt.py` (`loop_stats`, `_append_run`, `executor_choice`, `--executor`) — đọc
  2026-10-24; `research/2026-10-23-ceiling-analysis.md` §1 (`loop stats` trên clone = 0).
