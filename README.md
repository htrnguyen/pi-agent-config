# Pi Agent Configuration (`~/.pi/agent`)

Cấu hình cá nhân hóa cho **Pi Coding Agent**, tối ưu cho tốc độ, tiết kiệm chi phí token, kiểm soát ngữ cảnh (auto-compact 120k) và điều phối đa mô hình theo vai trò.

## 1. Kiến trúc & Điểm nổi bật

- **Auto-Compact thông minh (100k–150k, mặc định 120k)**: Tự động nén ngữ cảnh khi đạt ngưỡng (hoặc 75% `contextWindow` với model nhỏ) trước khi tràn bộ nhớ.
- **Router & Role-based Models (`roles.json` + `01-router-roles.ts`)**:
  - `default`: `openai-codex/gpt-6-luna:low` (fallback `antigravity/gemini-3.8-flash:low`)
  - `coding`: `openai-codex/gpt-6.1-terra:medium` (fallback `antigravity/claude-sonnet-5-5:medium`)
  - `plan`: `openai-codex/gpt-6.1-sol:medium` (Read-only, fallback `antigravity/claude-opus-5-5:medium`)
  - `slow`: `openai-codex/gpt-6.1-sol:high` (fallback `genz-codex/gpt-6.1-terra:high`)
  - `smol` / `task` / `commit`: `openai-codex/gpt-6-luna:low` (fallback `zai/glm-5.3-flash:low`)
  - `advisor`: `genz-codex/codex-auto-review:medium` (Read-only)
  - Mỗi role chỉ dùng **1 fallback duy nhất** để tránh dây chuyền retry gây trễ.
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
