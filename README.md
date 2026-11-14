# Tavern Card Translator — Dịch card SillyTavern Trung → Việt

App chạy cục bộ (giống SillyTavern) để Việt hóa **card nhân vật SillyTavern**, đặc biệt là **card MVU / MVU Zod**:
dịch đầy đủ mọi phần của card, **đồng bộ tên biến** ở mọi nơi, và **xem trước HTML của regex trước/sau khi dịch** với giao diện tương tác như trong ST.

## Chạy app

1. Cài [Node.js](https://nodejs.org) (bản LTS, ≥ 18).
2. Bấm đúp **`Start.bat`** → trình duyệt tự mở `http://127.0.0.1:8686/`.
   (Hoặc chạy `node server.js`. Đổi cổng: `node server.js --port 8687`.)
3. Đóng cửa sổ console để tắt app.

Không cần `npm install` — thư viện đã nằm sẵn trong `public/vendor/`.

## Quy trình dịch

1. **🔌 Kết nối API** — nhập *URL proxy* và *mật khẩu (key)* giống mục Reverse Proxy / Custom Endpoint của ST
   (hỗ trợ OpenAI-compatible, Claude, Gemini). Bấm **🔍 Quét model**, chọn model, **🧪 Kiểm tra kết nối**.
   Có thể lưu nhiều hồ sơ proxy.
2. **🎛️ Preset & Tham số** — **📥 Nhập preset ST** (file `.json` Chat Completion, hoặc kéo-thả vào cửa sổ).
   Preset được giữ nguyên vẹn (xuất lại y chang). Chỉnh sampler (temperature, top_p, top_k, min_p…), Prompt Manager
   (bật/tắt, kéo-thả, sửa, prompt in-chat theo độ sâu), prefill, reasoning effort…
   Bật *“Dùng các prompt đang BẬT của preset khi dịch”* nếu muốn dùng preset phá giới hạn.
3. **📥 Nhập card** (`.png` hoặc `.json`, V1/V2/V3) → tab **📇 Card & Bản dịch** hiện cây các phần của card.
4. **🧬 Biến & Đồng bộ** — xem bảng biến MVU / giá trị enum / nhãn regex / thuật ngữ, chọn kiểu đặt tên,
   bấm **✨ AI gợi ý**, sửa tay nếu muốn, **🧪 Kiểm tra schema Zod** (chạy schema của card với InitVar gốc & sau dịch).
5. **▶ Dịch toàn bộ** (thanh trên cùng). App tự gợi ý từ điển còn trống rồi dịch theo lô, song song, có thử lại.
6. **🧩 Regex & Xem trước** — bấm **🧪 Thử** ở từng regex, hoặc dán tin nhắn AI mẫu → so sánh 2 cột
   *Bản gốc | Bản dịch*: regex áp dụng như ST (placement, chỉ hiển thị/chỉ prompt, độ sâu, `$1`, `{{match}}`),
   khối HTML chạy trong iframe với API giả lập Tavern Helper + MVU (`getVariables`, `getAllVariables`,
   `Mvu.getMvuData`, `triggerSlash`, `setChatMessages`, `eventOn`, `SillyTavern.getContext`…). Nút bấm trong
   giao diện card hoạt động: đổi lời chào (swipe), `/send`, `/echo`… Biến `stat_data` lấy từ InitVar (qua schema Zod)
   và cập nhật theo `<UpdateVariable>` (lệnh `_.set` hoặc JSON Patch) trong tin nhắn mẫu.
7. **💾 Xuất card** → PNG (ghi chunk `chara` + `ccv3` giống ST) hoặc JSON.

Dự án (bản dịch, từ điển, chỉnh tay) tự lưu trong `data/projects/` — mở lại bằng nút **📂 Dự án**.

## Đồng bộ biến hoạt động thế nào

App phân tích từng phần của card thành **chữ cần dịch** và **phần giữ nguyên** (thẻ HTML, mã JS/CSS, macro, `$1`,
đường dẫn biến…). Phần giữ nguyên được thay bằng placeholder `⟦n⟧` khi gửi cho AI, rồi ghép lại đúng vị trí —
mã nguồn ngoài chữ được giữ nguyên từng ký tự. Tên biến được thay **theo ngữ cảnh**, không thay chuỗi mù:

| Nơi xuất hiện | Ví dụ | Cách xử lý |
|---|---|---|
| InitVar (YAML/JSON) | `好感度: 100` | đổi khóa theo bảng, giá trị enum theo bảng |
| Schema Zod | `好感度: z.number()`, `z.enum(['白天'])` | khóa object, chuỗi enum, `.describe()` được dịch |
| Mã JS (status bar…) | `data.角色.好感度`, `'stat_data.'+cn+'.好感度'` | `.prop` → `['tên mới']` nếu có dấu cách, chuỗi đường dẫn |
| Macro / EJS | `{{getvar::stat_data.角色.好感度}}`, `getvar('...')` | ánh xạ đường dẫn |
| Quy tắc cập nhật | `角色.好感度:`, `"path": "/角色/好感度"` | khóa YAML & JSON Patch |
| Regex | `【开场白】([\s\S]*?)【\/开场白】` | đổi nhãn trong regex **và** trong lời chào/lorebook |
| Tên mục lorebook | `getwi(null, '▶️开局流程')` | đồng bộ với tên mục đã dịch |

Đổi bản dịch trong bảng biến → card cập nhật ngay, không cần gọi lại AI.
Muốn an toàn tuyệt đối: chọn *“Giữ nguyên tiếng Trung”* cho tên biến (vẫn dịch nội dung).

## Lưu ý

- Mật khẩu proxy lưu trong `data/settings/app.json` trên máy bạn — đừng chia sẻ thư mục `data/`.
- Iframe xem trước chạy trong sandbox, không truy cập được app/khóa API.
- Xem trước **không gọi AI** cho `/trigger`, `generate()`; chỉ mô phỏng.
- Regex literal chứa tiếng Trung trong mã JS (vd `/第([一二三])章/`) không tự dịch được — app sẽ cảnh báo để bạn kiểm tra.
- Kiểm thử: `npm test` (chạy trên các file card `.json` đặt ở thư mục gốc).
