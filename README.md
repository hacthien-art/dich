# Tavern Card Translator — Dịch card SillyTavern Trung → Việt

App chạy cục bộ (giống SillyTavern) để Việt hóa **card nhân vật SillyTavern**, đặc biệt là **card MVU / MVU Zod**:
dịch đầy đủ mọi phần của card, **đồng bộ tên biến** ở mọi nơi, và **xem trước HTML của regex trước/sau khi dịch** với giao diện tương tác như trong ST.

## Chạy app

1. Cài [Node.js](https://nodejs.org) (bản LTS, ≥ 18).
2. Bấm đúp **`Start.bat`** → trình duyệt tự mở `http://127.0.0.1:8686/`.
   (Hoặc chạy `node server.js`. Đổi cổng: `node server.js --port 8690` — cổng iframe xem trước sẽ là cổng + 1.)
3. Đóng cửa sổ console để tắt app.

**Cập nhật bản mới:** khi GitHub có bản mới, nút **⬆ Cập nhật** hiện trên thanh trên cùng → bấm để xem danh sách thay đổi
→ **Cập nhật ngay**. App tự tải bản mới (cài bằng `git clone`: `git fetch` + `git merge --ff-only`; cài bằng zip: tải zip nhánh
`main` và chép đè), tự khởi động lại và tải lại trang. Dữ liệu trong `data/` được giữ nguyên. Kiểm tra thủ công: bấm dòng
phiên bản ở góc dưới thanh bên, hoặc tab **⚙️ Cài đặt dịch → Cập nhật ứng dụng**. (Bản 1.0 chưa có nút này: lần đầu hãy
`git pull` hoặc tải lại zip.)

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
   Ở trang tóm tắt card có nút **🖼 Đổi ảnh / Thêm ảnh** (PNG/JPG/WebP) — ảnh dùng khi xuất PNG (card JSON không có ảnh).
4. **🧬 Biến & Đồng bộ** — xem bảng biến MVU / giá trị enum / nhãn regex / thuật ngữ, chọn kiểu đặt tên,
   bấm **✨ AI gợi ý**, sửa tay nếu muốn, **🧪 Kiểm tra schema Zod** (chạy schema của card với InitVar gốc & sau dịch).
   Ô tìm kiếm lọc theo gốc / bản dịch / ngữ cảnh, gõ không dấu cũng được (`do hao cam` → *Độ hảo cảm*).
   **Biến bị trùng tên** (2 biến khác nhau trong cùng object bị dịch thành một tên, vd 动向/动态 → *Động thái*) được
   **tự dịch lại**: sau bước gợi ý từ điển và trước khi dịch, app gửi các biến trùng cho AI đặt tên khác nhau (giữ mục bạn
   đã sửa tay); nếu AI vẫn đặt trùng thì thêm hậu tố số. Có nút **🤖 Tự dịch lại biến trùng** để chạy thủ công.
5. **▶ Dịch toàn bộ** (thanh trên cùng). App tự gợi ý từ điển còn trống rồi dịch theo lô, song song, có thử lại.
   Mỗi đoạn được kiểm tra: đủ placeholder, đủ macro, **không còn sót chữ Hán** (kể cả trong tên thẻ như
   `<姬悠馨_id40>`; chỉ những từ bạn tích "Giữ" hoặc tự sửa tay mới được phép còn chữ Hán), giữ đủ các ký hiệu mà regex
   của card cần (`「」`, `【】`…) và dấu `< >` của thẻ tên tiếng Trung; nhãn phân loại `[biến]` / `[giá trị]` AI lỡ chép vào bị
   gỡ tự động. Đoạn lỗi được tự dịch lại kèm ghi chú lỗi cho AI; nếu vẫn lỗi thì được gắn ⚠. Gợi ý từ điển mà AI trả về vẫn
   còn chữ Hán (chữ hiếm như 冉駹) không được nhận — app hỏi lại, rồi báo ở tab Kiểm tra nếu vẫn không dịch được.
   Bấm **🔁 Dịch chỗ thiếu/lỗi (N)** để dịch lại riêng các đoạn chưa dịch hoặc bị ⚠ (bản cũ được giữ nếu dịch lại hỏng).
   Trong tab Card có nút **🔁 Dịch đoạn lỗi** cho từng mục và bộ lọc *“Chỉ hiện mục chưa dịch xong / có lỗi”*.
6. **🧩 Regex & Xem trước** — bấm **🧪 Thử** ở từng regex, hoặc dán tin nhắn AI mẫu → so sánh 2 cột
   *Bản gốc | Bản dịch*: regex áp dụng như ST (placement, chỉ hiển thị/chỉ prompt, độ sâu, `$1`, `{{match}}`),
   khối HTML chạy trong iframe với API giả lập Tavern Helper + MVU (`getVariables`, `getAllVariables`,
   `Mvu.getMvuData`, `triggerSlash`, `setChatMessages`, `eventOn`, `SillyTavern.getContext`…). Nút bấm trong
   giao diện card hoạt động: đổi lời chào (swipe), `/send`, `/echo`… Biến `stat_data` lấy từ InitVar (qua schema Zod)
   và cập nhật theo `<UpdateVariable>` (lệnh `_.set` hoặc JSON Patch) trong tin nhắn mẫu.
7. **🩺 Kiểm tra** — kiểm tra tổng thể card **xuất ra** (không gọi AI, tự chạy sau mỗi lần dịch toàn bộ và trước khi xuất):
   chữ Hán còn sót ở mọi nơi (phân loại: AI dịch sót / đoạn chưa dịch / mục từ điển chưa dịch / chuỗi trong mã được giữ),
   từ điển chưa dịch hoặc trùng tên (kể cả chỉ khác chữ hoa/thường như *Chân* / *chân*), nhãn `[biến]` / placeholder lọt vào
   card, EJS và script còn biên dịch được, InitVar còn là YAML đúng cấu trúc, đường dẫn biến khớp từ điển, **find regex còn
   khớp văn bản sau dịch**, `getwi()` trỏ đúng tên mục, `$1` / macro / thẻ HTML không bị mất. Bấm **Mở mục** để tới chỗ lỗi;
   có nút AI dịch các mục từ điển còn thiếu và nút thêm các chuỗi tiếng Trung còn sót trong mã vào từ điển.
8. **💾 Xuất card** → PNG (ghi chunk `chara` + `ccv3` giống ST, tự kiểm tra CRC/IHDR/IEND như ST trước khi tải về) hoặc JSON.
   *File PNG xuất từ bản 1.0 bị sai CRC nên ST không nhập được — hãy nhập lại file đó (hoặc mở dự án) rồi xuất lại.*

Dự án (bản dịch, từ điển, chỉnh tay) tự lưu trong `data/projects/` — mở lại bằng nút **📂 Dự án**.

### Card có bản cập nhật — không phải dịch lại từ đầu

Bấm **🔄 Cập nhật card** (thanh trên cùng, hoặc trang tóm tắt card) và chọn file card mới; hoặc nhập thẳng file mới — nếu tên
card trùng một dự án đã dịch, app hỏi có muốn cập nhật dự án đó không. App thay card gốc nhưng giữ:

- **bản dịch**: đoạn nào văn bản nguồn không đổi thì dùng lại ngay; đoạn dài chỉ bị sửa/thêm vài dòng thì chỉ gửi AI **các dòng
  mới** rồi ghép với bản dịch cũ; đoạn bị cắt lại ở chỗ khác được ghép từ các đoạn văn đã dịch;
- **từ điển biến** (bản dịch, "Giữ", sửa tay; mục tạm biến mất được cất lại để dùng nếu xuất hiện lại);
- **chỉnh tay** của các mục không đổi, lựa chọn *không dịch mục này*.

Hộp thoại sau khi cập nhật cho biết mục nào được sửa / thêm / xóa, bao nhiêu đoạn dùng lại, còn bao nhiêu ký tự phải dịch, có
nút **▶ Dịch phần mới** và **↶ Hoàn tác** (khi chọn nhầm file).

### Nâng cấp từ bản 1.1

Khi mở dự án cũ, app tự: gỡ nhãn `[biến]` / `[giá trị]` bị AI chép vào bản dịch và từ điển, chuyển bản dịch cũ sang cách phân
tích mới (nhãn `【…】`, `$1`), kiểm tra lại toàn bộ bản dịch theo quy tắc chữ Hán chặt hơn. Một số đoạn có thể chuyển sang
"chưa dịch" / ⚠ (vd chuỗi câu văn trong mã EJS trước đây bị bỏ sót, thuộc tính HTML có nháy lồng) — bấm **🔁 Dịch chỗ thiếu/lỗi**.

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
| Regex | `【开场白】([\s\S]*?)【\/开场白】` | đổi nhãn trong regex **và** trong lời chào/lorebook (cả ngoặc 【】 được khóa, AI không đổi được); thẻ `<状态栏>…</状态栏>` mở/đóng đổi cùng nhau; tên nhóm `(?<名字>)` / `$<名字>` giữ nguyên; dấu `：，（）` trong regex nhận cả dấu ASCII (`[：:]\s*`) vì bản dịch viết "Độ hảo cảm: 50" |
| Replace của regex | `$1` trong chữ, thuộc tính, chuỗi JS, CSS | luôn được khóa — AI không thể làm mất / đổi `$1` |
| Tên mục lorebook | `getwi(null, '▶️开局流程')` | đồng bộ với tên mục đã dịch |

| Giá trị ghép | `标签: 权势、高知、舆论` + mã `TAG_MEANS = { 权势: […] }` | tách thành từng nhãn, dịch từng nhãn, giữ dấu `、` → mã `split()` rồi tra bảng vẫn khớp |
| Placeholder quy tắc MVU | `队伍.${外貌\|性格}:` / `队伍.${角色名}:` | đổi từng khóa trong `${…}` |
| Script Tavern Helper | nút `getButtonEvent('刷新')`, biến nhân vật / `data` của script | tên nút và lời gọi đổi cùng nhau (nút của bundle MVU giữ nguyên); biến TH đổi khóa theo bảng |
| Mã JS | `class A { 名() {} }`, `get 名()`, regex literal `/【开场白】/` | định nghĩa và chỗ gọi đổi cùng nhau; nhãn trong regex đổi theo bảng |

Đổi bản dịch trong bảng biến → card cập nhật ngay, không cần gọi lại AI.
Muốn an toàn tuyệt đối: chọn *“Giữ nguyên tiếng Trung”* cho tên biến (vẫn dịch nội dung).

## EJS (ST-Prompt-Template) & Tavern Helper

- Thẻ EJS `<% %>` được tách khỏi văn bản: lệnh điều khiển (`<% if (…) { %> … <% } %>`) là **ranh giới đoạn** nên AI không thể
  đảo vị trí `if/else`; chữ giữa các lệnh vẫn được dịch.
- Chuỗi trong thẻ xuất `<%= %>` / `<%- %>`, `print('…')` và chuỗi là **câu văn** trong thẻ mã `<% %>` (có dấu câu tiếng Trung
  hoặc dài — vd `notes.push('有机缘的槐叶、神仙钱…')`) được dịch; chuỗi ngắn trong thẻ mã (giá trị trạng thái, tên) và chuỗi
  dùng để so sánh / làm khóa / gọi `getwi()`, `setvar()` **giữ nguyên** — chỉ đồng bộ biến/tên mục. Bật *“Dịch cả chuỗi
  ngắn trong mã EJS”* nếu card chỉ dùng EJS để hiển thị chữ.
- `getwi(null, '▶️开局流程')` → đổi theo tên mục đã dịch. Tên mục bị **ghép động** (`getwi(null, sách + ' / 第' + n + '章')`,
  `e.comment.includes('事件')`) được phát hiện và **giữ nguyên** để mã vẫn tìm thấy mục.
- Tên mục lorebook trùng một mục từ điển (vd mục `学校` và giá trị địa điểm `学校`) dùng đúng bản dịch từ điển, nên
  `getwi(null, địa_điểm)` vẫn tìm thấy mục sau khi dịch.
- Bản dịch không thể cắt ngang thẻ EJS (`%>` trong chuỗi → `%\>`), không thể làm “thoát” chú thích (`//` ép 1 dòng,
  `*/` và `-->` bị vô hiệu), decorator `@@generate_before`… được giữ nguyên.
- Chú thích trong mã (`//`, `/* */`, `<!-- -->`, `<%# %>`) **được dịch mặc định** từ bản 1.1 (tắt ở tab Cài đặt dịch).
- Thuộc tính `data-*` là câu chữ/prompt (`data-prompt="…"`, `data-close="点击查看"`) được dịch; `data-*` là khóa trong
  từ điển thì đồng bộ; còn lại giữ nguyên. Văn bản chỉ *nhắc tới* thẻ `<style>`/`<script>` không bị coi là CSS/JS.

## Lưu ý

- Mật khẩu proxy lưu trong `data/settings/app.json` trên máy bạn — đừng chia sẻ thư mục `data/`.
- Iframe xem trước chạy trên **cổng riêng** (mặc định 8687, khác origin với app) nên code của card không đọc được
  app/khóa API, nhưng vẫn có `localStorage`/`IndexedDB` thật. `window.parent`/`window.top` được giả lập giống ST
  (`#chat`, `#send_textarea`, `#send_but`…): card gửi tin qua `parent.document` vẫn hoạt động trong khung xem trước.
  Nếu cổng 8687 bị chặn, app tự chuyển sang iframe sandbox dự phòng (không có IndexedDB).
- Tiện ích dịch trình duyệt (vd *Immersive Translate*) có thể chèn vào iframe và báo lỗi đỏ trong Console
  (`content_main.js`, `[frame-bridge]`) — không phải lỗi của app; nên tắt tiện ích đó cho `127.0.0.1`.
- Xem trước **không gọi AI** cho `/trigger`, `generate()`; chỉ mô phỏng.
- Lỗi phía server được ghi vào `data/server.log` (gửi file này khi báo lỗi).
- Regex literal chứa tiếng Trung không phải mục từ điển (vd `/第([一二三])章/`) không tự dịch được — app sẽ cảnh báo để bạn kiểm tra.
- Tên font chữ Trung trong CSS (`'宋体'`, `'楷体'`) cố ý giữ nguyên.
- Kiểm thử: `npm test` (chạy trên các file card `.json` đặt ở thư mục gốc).
