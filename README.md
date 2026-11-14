# Pi Agent Configuration

Cấu hình cá nhân hóa cho **Pi Coding Agent**, thiết kế theo hướng **mô-đun hóa, mượt UI, kiểm soát chi phí/ngữ cảnh và tự động kiểm chứng code cục bộ**. Toàn bộ model, ngưỡng và package đều cấu hình qua JSON (`settings.json`, `roles.json`, `mcp.json`) — không hardcode trong tài liệu hay extension.

---

## 1. Cấu trúc thư mục

```text
.
├── AGENTS.md              # Quy tắc làm việc chung cho mọi session
├── settings.json          # Packages, subagents, theme, memory & compaction
├── roles.json             # Định nghĩa các role model & ngưỡng advisory router
├── mcp.json               # Cấu hình MCP servers
├── models.example.json    # Mẫu cấu hình provider/API key (copy -> models.json)
├── keybindings.json       # Phím tắt tùy biến
├── pi-icon.svg            # Icon cho thông báo desktop
├── extensions/            # Các extension TypeScript nạp nóng qua /reload
├── skills/                # Tập hợp skill chuyên biệt theo tác vụ
├── themes/                # Giao diện màu (vd: tokyo-clean, omarchy-system)
└── lib/                   # Thư viện dùng chung (thống kê token, chi phí, tốc độ)
```

---

## 2. Kiến trúc & Tính năng chính

### UI, Input & Trạng thái Realtime (`extensions/00-control-panel.ts`)
- **HUD viền ô nhập**: Hiển thị Role hiện tại (kèm cờ `[RO]` nếu read-only), Model, mức Thinking, trạng thái Advisor (`adv:on/off`), ngữ cảnh/chi phí và tốc độ `tok/s`.
- **Trạng thái task realtime**: Hiển thị spinner, tác vụ hiện tại (`thinking`, `edit ...`, `bash ...`), đồng hồ đếm thời gian chạy và trạng thái hoàn tất (`✓ done`) ngay trên viền trên.
- **Thu gọn Paste & Ảnh đồng nhất**:
  - Paste text dài (`> 20` dòng hoặc `> 400` ký tự) qua `Ctrl+V`, `Ctrl+Shift+V` hoặc raw paste tự động thu gọn thành `[paste #N ...]`.
  - Paste ảnh (`Ctrl+V` hoặc kéo thả file ảnh) tự động thu gọn thành `[img #N]`.
  - Thanh attachment 1 dòng phía trên ô nhập hiển thị độ phân giải/dung lượng/định dạng ảnh hoặc tóm tắt đoạn paste.
- **Tối ưu hiệu năng**: Cache cấu hình và chi phí session trong RAM để gõ phím và render không bị khựng.

### Điều phối Role & Advisory Router (`extensions/01-router-roles.ts`, `roles.json`)
- Phân tách model theo vai trò trong `roles.json` (tác vụ thường, coding, planning/read-only, debug sâu, advisor độc lập).
- Hỗ trợ khóa write tools trên các role chỉ đọc (`readOnly`), đồng bộ với `extensions/10-tools.ts`.
- **Advisory Router**: Chỉ kích hoạt trên prompt phức tạp hoặc khi đang ở paid role (không chặn `Enter` ở các câu hỏi thông thường), gợi ý chuyển role có xác nhận và không tự ý đổi sang paid model.

### Kiểm chứng & Review độc lập (`extensions/02-advisor-review.ts`)
- **Guardrails**: Bảo vệ các đường dẫn nhạy cảm và chặn lệnh ghi trong role `[RO]`.
- **Verification Guard**: Nhắc chạy kiểm tra thực tế (test/lint/typecheck/compile) nếu phát hiện sửa code mà chưa verify.
- **Independent Advisor**: Khi `adv:on` và code đã pass verify, gọi model Advisor cấu hình trong `roles.json` để review diff độc lập và hiển thị đầy đủ kết quả (`APPROVE` / `REQUEST_CHANGES`) lên khung chat.

### Auto-Check cục bộ miễn phí (`extensions/15-auto-check.ts`)
- Tự động chạy sau mỗi lần `write` / `edit` trên file code (bỏ qua `.md`, `.txt`, `.log`, `node_modules`, `.venv`, `.git`):
  - **Python**: `py_compile`, `ruff`, `pyright` / `ty` (ưu tiên binary trong `.venv` của project trước bản global).
  - **TypeScript / JavaScript**: `biome` / `eslint` của project, `tsc --noEmit` (nếu có `tsconfig.json`), `node --check`.
  - **Shell / JSON**: `bash -n`, `shellcheck` (nếu có), `JSON.parse`.
- **Im lặng khi sạch**, tự gắn lỗi vào kết quả tool khi phát hiện vấn đề và hiển thị trạng thái `check:on(...)` / `check:off` trên thanh status.

### Tiện ích Developer & Thông báo
- **Copy & Lịch sử lệnh (`extensions/14-dev-copy.ts`)**: Trích xuất/copy nhanh code block, script bash từ phản hồi, xem log lệnh đã chạy, xóa nhanh ô nhập.
- **Git Checkpoint (`extensions/06-git-checkpoint.ts`)**: Tạo và khôi phục nhanh trạng thái làm việc bằng Git stash.
- **Desktop Notify (`extensions/12-notify.ts`)**: Bắn popup desktop (`notify-send` kèm `pi-icon.svg`) + âm thanh hệ thống khi hoàn thành task (fallback sang OSC terminal / Windows Toast).
- **Mở rộng khác**: Chuyển giao ngữ cảnh (`03-handoff.ts`), Q&A (`07-qna.ts`), inline bash (`08-inline-bash.ts`), shell tương tác (`09-interactive-shell.ts`), bookmark (`11-bookmark.ts`), nạp rules dự án (`13-claude-rules.ts`).

---

## 3. Phím tắt & Lệnh nhanh

| Phím tắt / Lệnh | Chức năng |
| :--- | :--- |
| `Ctrl+L` / `Alt+L` / `/models` | Chọn Model phân nhóm theo Provider |
| `Alt+M` / `/menu` | Mở Command Hub phân nhóm chức năng |
| `Alt+S` / `/setup` | Bảng điều khiển nhanh (HUD, Router, Advisor, Compact...) |
| `Alt+R` / `/role` | Chuyển nhanh giữa các Role trong `roles.json` |
| `Alt+C` / `/copy` | Mở danh sách copy nhanh code block / lệnh bash từ chat |
| `Alt+X` | Xóa nhanh toàn bộ nội dung đang nhập trong ô chat |
| `/cmdlog` | Xem và copy các lệnh terminal đã chạy trong session |
| `/autocheck` | Bật/tắt hoặc xem trạng thái Auto-Check (`on \| off \| status`) |
| `/advisor` / `/review` | Bật/tắt Advisor real-time hoặc chạy review thủ công trên `git diff` |
| `/notify` | Cấu hình hoặc test thông báo desktop (`on \| off \| sound on \| sound off \| test`) |
| `/checkpoint` | Tạo hoặc khôi phục Git checkpoint |
| `/stats` / `/cost` / `/speed` | Xem thống kê token, chi phí và tốc độ `tok/s` |
| `/handoff` | Chuyển giao ngữ cảnh rút gọn sang session mới |
| `/reload` | Nạp lại toàn bộ extension và cấu hình không cần thoát Pi |

---

## 4. Cài đặt trên máy mới

```bash
git clone <repo-url> ~/.pi/agent
cd ~/.pi/agent
npm install
cp models.example.json models.json
# Điền API key vào models.json và đăng nhập provider trong Pi
```

*(Tùy chọn)* Để `15-auto-check.ts` kiểm tra Python đầy đủ ở mức global ngoài `.venv`:

```bash
uv tool install ruff
uv tool install ty
```
