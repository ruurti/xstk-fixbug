document.addEventListener("DOMContentLoaded", () => {
    fetchUserProfile();
    fetchUpcomingMatches();
});

// 1. Lấy thông tin User đã login qua Cloudflare
async function fetchUserProfile() {
    const userInfoEl = document.getElementById("user-info");
    try {
        const response = await fetch("/api/v1/me");
        if (!response.ok) throw new Error("Chưa xác thực");
        const user = await response.json();
        
        // Cắt ngắn email cho gọn giao diện mobile nếu quá dài
        const shortEmail = user.email.split('@')[0];
        userInfoEl.innerHTML = `👤 <span class="font-semibold text-white">${shortEmail}</span> | 🪙 <span class="text-yellow-400 font-bold">${user.total_points}đ</span>`;
    } catch (error) {
        userInfoEl.innerHTML = `<span class="text-red-400 font-medium">Lỗi kết nối Auth</span>`;
    }
}

// 2. Lấy danh sách trận đấu và render giao diện mobile-first
async function fetchUpcomingMatches() {
    const matchListEl = document.getElementById("match-list");
    try {
        const response = await fetch("/api/v1/matches");
        const matches = await response.json();

        if (matches.length === 0) {
            matchListEl.innerHTML = `
                <div class="text-center py-12 text-gray-500 text-sm">
                    Hiện chưa có trận đấu nào sắp diễn ra.
                </div>`;
            return;
        }

        matchListEl.innerHTML = matches.map(match => {
            // Định dạng thời gian hiển thị gọn gàng trên mobile (HH:MM - DD/MM)
            const matchDate = new Date(match.start_time);
            const timeStr = matchDate.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
            const dateStr = matchDate.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit' });

            return `
                <div class="bg-gray-800 border border-gray-700 hover:border-emerald-500/50 rounded-xl p-4 shadow-sm transition duration-200 active:scale-[0.99] clickable-card">
                    <div class="text-center mb-2">
                        <span class="text-xs bg-gray-900 text-emerald-400 font-mono font-semibold px-2 py-1 rounded">
                            ⏰ ${timeStr} - ${dateStr}
                        </span>
                    </div>
                    
                    <div class="flex items-center justify-between my-3 px-2">
                        <div class="w-2/5 text-center">
                            <p class="text-sm font-bold text-white truncate">${match.home_team}</p>
                            <span class="text-xs text-gray-400 block mt-0.5">Chủ nhà</span>
                        </div>
                        
                        <div class="w-1/5 text-center text-gray-500 font-black text-sm">VS</div>
                        
                        <div class="w-2/5 text-center">
                            <p class="text-sm font-bold text-white truncate">${match.away_team}</p>
                            <span class="text-xs text-gray-400 block mt-0.5">Khách</span>
                        </div>
                    </div>

                    <div class="mt-3">
                        <button onclick="openBetModal(${match.id}, '${match.home_team}', '${match.away_team}')" 
                                class="w-full bg-emerald-600 hover:bg-emerald-500 active:bg-emerald-700 text-white text-xs font-bold py-2.5 px-4 rounded-lg shadow transition duration-150">
                            Đặt Cược Tỉ Số
                        </button>
                    </div>
                </div>
            `;
        }).join('');

    } catch (error) {
        matchListEl.innerHTML = `
            <div class="text-center py-8 text-red-400 text-xs">
                Không thể tải danh sách trận đấu. Vui lòng thử lại sau!
            </div>`;
    }
}

// Hàm xử lý khi ấn cược (Sẽ phát triển logic gửi cược ở bài học sau)
function openBetModal(matchId, home, away) {
    alert(`Bạn đang chọn cược trận: ${home} vs ${away} (ID: ${matchId}). Tính năng cược sẽ được xử lý ở bước tiếp theo!`);
}