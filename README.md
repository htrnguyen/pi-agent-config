# Pi Agent Configuration (`~/.pi/agent`)

Cấu hình cá nhân hóa cho **Pi Coding Agent**, tối ưu cho tốc độ, tiết kiệm chi phí token, kiểm soát ngữ cảnh (auto-compact 120k) và điều phối đa mô hình theo vai trò.

## 1. Kiến trúc & Điểm nổi bật

- **Auto-Compact & Memory thống nhất (120k tokens)**: Điều khiển bởi `pi-observational-memory` (ghim cố định `zai/glm-5.3-flash:low` cho Observer/Reflector nền, không dùng ngầm Paid API).
- **Hybrid Advisory Router & 5 Task Roles (`roles.json` + `01-router-roles.ts`)**:
  - `default`: `openai-codex/gpt-6-luna:low` (fallback `zai/glm-5.3-flash:low`) — Hỏi đáp, đọc hiểu codebase & tác vụ hằng ngày.
  - `coding`: `openai-codex/gpt-6-luna:medium` (fallback `antigravity/gemini-3.8-flash:medium`) — Implement, sửa bug & refactor chính.
  - `plan`: `genz-codex/gpt-6.1-sol:high` (Read-only, fallback `openai-codex/gpt-6-luna:high`) — Thiết kế kiến trúc & lập kế hoạch.
  - `slow`: `genz-codex/gpt-6.1-terra:high` (fallback `openai-codex/gpt-6-luna:high`) — Debug sâu, race condition & bài toán kiến trúc khó.
  - `advisor`: `antigravity/gemini-3.8-flash:medium` (Read-only, fallback `zai/glm-5.3-flash:medium`) — Review code độc lập, tìm edge cases & regression.
  - Advisory Router dùng `zai/glm-5.3-flash:low` ở chế độ **suggest-only (Yes/No)**, có Rule Gate bỏ qua nhanh các câu tiếp nối và không bao giờ tự động chuyển sang Paid API.
- **4 Subagents chuyên biệt (`settings.json` + `pi-subagents`)**:
  - `scout` (`zai/glm-5.3-flash:low`, Read-only), `researcher` (`antigravity/gemini-3.8-flash:low`), `worker` (`openai-codex/gpt-6-luna:medium`), `reviewer` (`antigravity/gemini-3.8-flash:medium`, Read-only + `git diff`), giới hạn tối đa 3 tiến trình song song.
- **Thống kê Token, Chi phí & Tốc độ (`lib/stats/` + `00-control-panel.ts`)**:
  - Tự động đo và lưu `tok/s` thực tế của từng model.
  - Báo cáo chi phí & token theo ngày/model bằng tiếng Anh qua `/stats` hoặc `/cost`.

## 2. Phím tắt & Lệnh nhanh

| Phím tắt / Lệnh | Chức năng |
| :--- | :--- |
| `Ctrl+L` / `Alt+L` / `/models` | Chọn Model phân nhóm theo từng Provider (kèm giá & `tok/s`) |
| `Alt+M` / `/menu` | Mở Command Hub phân nhóm toàn bộ chức năng |
| `Alt+S` / `/setup` | Bảng điều khiển nhanh (Role, Auto-Route, Advisor, Compact Threshold...) |
| `Alt+R` / `/role` | Chuyển nhanh giữa các Role (`default`, `coding`, `plan`, `slow`, `smol`...) |
| `/speed` | Xem bảng tốc độ `tok/s`, giá tiền (`$in/$out/cache`) và context window |
| `/stats` hoặc `/cost` | Báo cáo tổng token & chi phí theo model/ngày (`--daily`, `--project`, `A..B`) |
| `/usage` | Xem hạn mức quota ngày/tuần của các Provider |
| `/review` / `/advisor` | Chạy code review độc lập trên `git diff` hoặc bật/tắt real-time advisor |
| `/checkpoint` | Tạo hoặc khôi phục Git checkpoint (`git stash`) |
| `/handoff` | Chuyển giao mục tiêu và ngữ cảnh rút gọn sang phiên làm việc mới |

## 3. Khôi phục trên máy mới

```bash
git clone https://github.com/htrnguyen/pi-agent-config.git ~/.pi/agent
cd ~/.pi/agent
npm install
cp models.example.json models.json
# Điền API key vào models.json và đăng nhập các provider trong pi
```
