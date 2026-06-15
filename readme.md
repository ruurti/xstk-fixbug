# Betting Realtime Engine (Learning Project)

Dự án học tập xây dựng hệ thống backend tính điểm dự đoán tỉ số bóng đá theo thời gian thực (Real-time). Hệ thống sử dụng mô hình kiến trúc Zero Trust, ủy quyền toàn bộ việc định danh người dùng cho Cloudflare Access và lưu trữ dữ liệu gọn nhẹ bằng SQLite.

## 🛠 Tech Stack

* **Backend Framework:** FastAPI (Python)
* **Database:** SQLite (Async với aiosqlite)
* **ORM:** SQLAlchemy (Async)
* **Authentication & Gateway:** Cloudflare Tunnel + Cloudflare Access (Zero Trust)
* **Process Manager (Production):** Linux Systemd

---

## 📋 Yêu cầu hệ thống (Prerequisites)

Trước khi cài đặt, đảm bảo máy/server của bạn đã cài sẵn:
* Python 3.9+
* Cloudflared CLI

---

## 🚀 Hướng dẫn Cài đặt & Khởi tạo Môi trường

Di chuyển vào thư mục dự án và thiết lập môi trường ảo (Virtual Environment) để cô lập các thư viện:

```bash
# 1. Di chuyển vào thư mục dự án
cd football-betting

# 2. Tạo môi trường ảo
python3 -m venv venv

# 3. Kích hoạt môi trường ảo
source venv/bin/activate
# (Nếu dùng Windows: venv\Scripts\activate)

# 4. Cài đặt các thư viện phụ thuộc
pip install -r requirements.txt

#5. Chạy ở Môi trường Phát triển (Local Dev)
uvicorn app.main:app --reload --host 127.0.0.1 --port 8000 --workers 1

```
## 💻 Hướng dẫn Chạy Ứng dụng

Do hệ thống sử dụng **SQLite**, cơ chế khóa file (`write-lock`) yêu cầu ứng dụng luôn luôn phải vận hành dưới dạng **đơn tiến trình (1 Worker)** nhằm loại bỏ hoàn toàn lỗi tranh chấp database (`database is locked`).

### 1. Chạy ở Môi trường Phát triển (Local Development)
Dùng lệnh này trên Terminal máy cá nhân để vừa code vừa theo dõi Log Debug trực tiếp. File cơ sở dữ liệu `betting_db.db` sẽ tự động được sinh ra ở thư mục gốc khi bạn khởi chạy lệnh này lần đầu tiên.

*Kích hoạt môi trường ảo trước khi chạy:*
```bash
source venv/bin/activate
```
Lệnh khởi chạy ứng dụng:

```Bash
uvicorn app.main:app --host 127.0.0.1 --port $PORT --workers 1 --reload
```
### 2. Chạy Ngầm Bền Bỉ Trên Server (Môi trường Vận hành)
Khi mang dự án lên server (ví dụ: máy chạy Debian/Ubuntu), thay vì dùng Gunicorn, chúng ta giao quyền quản lý tiến trình trực tiếp cho Systemd để bọc ngoài Uvicorn, giúp tối ưu tài nguyên RAM và tự động khôi phục khi sập.

#### Bước 2.1: Tạo file cấu hình service hệ thống:

```Bash
sudo nano /etc/systemd/system/betting-app.service
```
#### Bước 2.2: Dán nội dung cấu hình này vào (Lưu ý thay đổi đường dẫn /path/to/... cho đúng với thư mục thực tế trên server của bạn):
```

[Unit]
Description=FastAPI Betting Application Engine
After=network.target

[Service]
User=root
WorkingDirectory=/path/to/your/football-betting
# Thực thi uvicorn trực tiếp từ môi trường ảo venv và ép chạy duy nhất 1 worker
ExecStart=/path/to/your/football-betting/venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8000 --workers 1
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

#### Bước 2.3: Nạp lại cấu hình và kích hoạt chạy ngầm cùng hệ thống:

```Bash
# Nạp lại cấu hình hệ thống
sudo systemctl daemon-reload

# Khởi chạy ứng dụng lần đầu
sudo systemctl start betting-app

# Kích hoạt tính năng tự khởi động lại khi server reboot
sudo systemctl enable betting-app
```