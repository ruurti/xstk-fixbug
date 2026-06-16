// ─── State ───────────────────────────────────────────────────────────────────
let _profileData  = null;
let _selectedFile = null;
let openCardId    = null;
let _rechargeRequests = [];

function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, ch => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        "\"": "&quot;",
        "'": "&#39;",
    }[ch]));
}

function normalizeImageSrc(value) {
    const src = String(value ?? "").trim();
    if (!src) return "";
    if (src.startsWith("/") || /^https?:\/\//i.test(src)) return src;
    return "";
}

function safeImageSrc(value) {
    return escapeHtml(normalizeImageSrc(value));
}

function safeCssColor(value) {
    const color = String(value ?? "").trim();
    return /^#[0-9a-f]{6}$/i.test(color) ? color : "#6366f1";
}

function formatCoins(value) {
    return `${Number(value || 0).toLocaleString()}d`;
}

document.addEventListener("DOMContentLoaded", () => {
    fetchProfile();
    fetchBetHistory();
    fetchRechargeRequests();
    initAvatarModal();
    initNameModal();
    initRechargeModal();
});

// ─── Fetch & render profile ───────────────────────────────────────────────────
async function fetchProfile() {
    try {
        const res = await fetch("/api/v1/me");
        if (!res.ok) return;
        const data = await res.json();
        _profileData = data;
        applyProfileUI(data);
    } catch (err) {
        console.error("fetchProfile error:", err);
    }
}

function applyProfileUI(data) {
    const shortName = data.display_name || data.email.split("@")[0];
    const safeShortName = escapeHtml(shortName);

    document.getElementById("profile-name").textContent   = data.display_name || data.email.split("@")[0];
    document.getElementById("profile-email").textContent  = data.email;
    document.getElementById("profile-points").textContent = data.total_points.toLocaleString();

    document.getElementById("user-info").innerHTML =
        `${headerAvatarHtml(data)}
         <span class="font-semibold text-slate-900">${safeShortName}</span>
         &nbsp;|&nbsp; <span class="text-[#D3af37] font-bold">${data.total_points.toLocaleString()}</span>d`;

    renderAvatar(data);
}

function headerAvatarHtml({ avatar_url, avatar_color, initials }) {
    const avatarSrc = safeImageSrc(avatar_url);
    if (avatarSrc) {
        return `<img src="${avatarSrc}" style="width:20px;height:20px;border-radius:50%;object-fit:cover;
                     border:1px solid #38bdf8;vertical-align:middle;margin-right:5px;">`;
    }
    return `<span style="width:20px;height:20px;border-radius:50%;background:${safeCssColor(avatar_color)};
                  display:inline-flex;align-items:center;justify-content:center;
                  font-size:9px;font-weight:900;color:#fff;vertical-align:middle;
                  margin-right:5px;">${escapeHtml(initials || "??")}</span>`;
}

function renderAvatar({ avatar_url, avatar_color, initials }) {
    const initialsEl = document.getElementById("avatar-initials");
    const imgEl      = document.getElementById("avatar-img");
    const avatarSrc = normalizeImageSrc(avatar_url);
    if (avatarSrc) {
        imgEl.src = avatarSrc;
        imgEl.classList.remove("hidden");
        initialsEl.classList.add("hidden");
    } else {
        initialsEl.textContent     = initials || "??";
        initialsEl.style.background = safeCssColor(avatar_color);
        initialsEl.classList.remove("hidden");
        imgEl.classList.add("hidden");
    }
}

// ─── Avatar Modal ─────────────────────────────────────────────────────────────
function initAvatarModal() {
    const modal     = document.getElementById("avatar-modal");
    const openBtn   = document.getElementById("open-avatar-modal");
    const closeBtn  = document.getElementById("close-avatar-modal");
    const cancelBtn = document.getElementById("btn-avatar-cancel");
    const saveBtn   = document.getElementById("btn-avatar-save");
    const dropZone  = document.getElementById("avatar-drop-zone");
    const fileInput = document.getElementById("avatar-file-input");
    const preview   = document.getElementById("avatar-preview");
    const hint      = document.getElementById("drop-hint");
    const errorEl   = document.getElementById("avatar-error");
    const progressEl= document.getElementById("avatar-progress");

    const open  = () => { modal.classList.add("show"); reset(); };
    const close = () => { modal.classList.remove("show"); reset(); };

    function reset() {
        _selectedFile = null;
        preview.classList.remove("show"); preview.src = "";
        hint.style.display = "";
        saveBtn.disabled   = true;
        errorEl.classList.add("hidden"); errorEl.textContent = "";
        progressEl.classList.remove("show");
        fileInput.value = "";
    }

    function setFile(file) {
        if (!file) return;
        if (!file.type.startsWith("image/")) {
            return showErr(errorEl, "Chỉ chấp nhận file ảnh.");
        }
        if (file.size > 5 * 1024 * 1024) {
            return showErr(errorEl, "Ảnh quá lớn, tối đa 5MB.");
        }
        _selectedFile = file;
        const reader  = new FileReader();
        reader.onload = e => {
            preview.src = e.target.result;
            preview.classList.add("show");
            hint.style.display = "none";
        };
        reader.readAsDataURL(file);
        saveBtn.disabled = false;
        errorEl.classList.add("hidden");
    }

    openBtn.addEventListener("click", open);
    closeBtn.addEventListener("click", close);
    cancelBtn.addEventListener("click", close);
    modal.addEventListener("click", e => { if (e.target === modal) close(); });

    dropZone.addEventListener("click", () => fileInput.click());
    dropZone.addEventListener("dragover", e => { e.preventDefault(); dropZone.classList.add("dragover"); });
    dropZone.addEventListener("dragleave", () => dropZone.classList.remove("dragover"));
    dropZone.addEventListener("drop", e => {
        e.preventDefault(); dropZone.classList.remove("dragover");
        setFile(e.dataTransfer.files[0]);
    });
    fileInput.addEventListener("change", () => setFile(fileInput.files[0]));

    saveBtn.addEventListener("click", async () => {
        if (!_selectedFile) return;
        saveBtn.disabled = true;
        progressEl.classList.add("show");
        errorEl.classList.add("hidden");

        try {
            const form = new FormData();
            form.append("file", _selectedFile);

            const res = await fetch("/api/v1/me/avatar", { method: "POST", body: form });
            if (!res.ok) {
                const body = await res.json().catch(() => ({}));
                throw new Error(body.detail || `Lỗi ${res.status}`);
            }
            const { avatar_url } = await res.json();

            // Cập nhật UI ngay không cần reload
            const safeAvatarUrl = normalizeImageSrc(avatar_url);
            _profileData.avatar_url = safeAvatarUrl;
            const imgEl      = document.getElementById("avatar-img");
            const initialsEl = document.getElementById("avatar-initials");
            imgEl.src        = safeAvatarUrl + "?t=" + Date.now();
            imgEl.classList.remove("hidden");
            initialsEl.classList.add("hidden");
            // Cập nhật header mini avatar
            applyProfileUI({ ..._profileData, avatar_url: safeAvatarUrl });
            close();
        } catch (err) {
            showErr(errorEl, err.message || "Lỗi không xác định.");
            saveBtn.disabled = false;
            progressEl.classList.remove("show");
        }
    });

    document.addEventListener("keydown", e => {
        if (e.key === "Escape" && modal.classList.contains("show")) close();
    });
}

// ─── Display Name Modal ───────────────────────────────────────────────────────
function initNameModal() {
    const modal     = document.getElementById("name-modal");
    const openBtn   = document.getElementById("open-name-modal");
    const closeBtn  = document.getElementById("close-name-modal");
    const cancelBtn = document.getElementById("btn-name-cancel");
    const saveBtn   = document.getElementById("btn-name-save");
    const input     = document.getElementById("name-input");
    const counter   = document.getElementById("name-char-count");
    const errorEl   = document.getElementById("name-error");

    const open = () => {
        modal.classList.add("show");
        input.value      = _profileData?.display_name || "";
        counter.textContent = input.value.length;
        errorEl.classList.add("hidden");
        setTimeout(() => input.focus(), 80);
    };
    const close = () => modal.classList.remove("show");

    openBtn.addEventListener("click", open);
    closeBtn.addEventListener("click", close);
    cancelBtn.addEventListener("click", close);
    modal.addEventListener("click", e => { if (e.target === modal) close(); });

    input.addEventListener("input", () => {
        const len = input.value.length;
        counter.textContent = len;
        counter.parentElement.classList.toggle("warn", len > 25);
    });

    saveBtn.addEventListener("click", async () => {
        const name = input.value.trim();
        if (!name) return showErr(errorEl, "Tên không được để trống.");
        if (name.length > 30) return showErr(errorEl, "Tối đa 30 ký tự.");

        saveBtn.disabled = true;
        saveBtn.textContent = "Đang lưu...";
        errorEl.classList.add("hidden");

        try {
            const res = await fetch("/api/v1/me/update", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ display_name: name }),
            });
            if (!res.ok) {
                const body = await res.json().catch(() => ({}));
                throw new Error(body.detail || `Lỗi ${res.status}`);
            }
            const data = await res.json();
            _profileData = { ..._profileData, ...data };
            applyProfileUI(_profileData);
            close();
        } catch (err) {
            showErr(errorEl, err.message || "Lỗi không xác định.");
        } finally {
            saveBtn.disabled    = false;
            saveBtn.textContent = "Lưu tên";
        }
    });

    // Enter để lưu
    input.addEventListener("keydown", e => { if (e.key === "Enter") saveBtn.click(); });

    document.addEventListener("keydown", e => {
        if (e.key === "Escape" && modal.classList.contains("show")) close();
    });
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
function showErr(el, msg) {
    el.textContent = msg;
    el.classList.remove("hidden");
}

// ─── Bet History ─────────────────────────────────────────────────────────────
async function fetchBetHistory() {
    const listEl = document.getElementById("bet-list");
    try {
        const res = await fetch("/api/v1/me/bets");
        if (!res.ok) {
            listEl.innerHTML = `<div class="text-center text-red-400 py-8 text-sm">Không thể tải lịch sử cược.</div>`;
            return;
        }
        const bets = await res.json();
        renderStats(bets);
        renderBets(bets, listEl);
    } catch (err) {
        console.error(err);
        listEl.innerHTML = `<div class="text-center text-red-400 py-8 text-sm">Lỗi kết nối.</div>`;
    }
}

function renderStats(bets) {
    const finished = bets.filter(b => b.match_status === "finished");
    const wins     = finished.filter(b => b.points_earned > 0);
    const loses    = finished.filter(b => b.points_earned === 0);
    document.getElementById("stat-total").textContent = bets.length;
    document.getElementById("stat-win").textContent   = wins.length;
    document.getElementById("stat-lose").textContent  = loses.length;
}

// ─── Bet Cards ───────────────────────────────────────────────────────────────
function renderBets(bets, listEl) {
    if (bets.length === 0) {
        listEl.innerHTML = `
            <div class="text-center py-12 text-slate-500 text-sm">
                <div class="text-4xl mb-3">🎯</div>
                <div>Bạn chưa đặt cược lần nào.</div>
                <a href="/" class="text-sky-600 text-sm mt-2 inline-block hover:underline">Xem trận đấu ngay →</a>
            </div>`;
        return;
    }

    listEl.innerHTML = bets.map(b => {
        const isFinished = b.match_status === "finished";
        const isRefunded = isFinished && b.points_earned === null;
        const isWin      = isFinished && b.points_earned > 0;

        const badgeHtml = !isFinished
            ? `<span class="badge-pending text-xs px-2 py-0.5 rounded-full font-semibold">Đang chờ</span>`
            : isRefunded
                ? `<span class="badge-refund text-xs px-2 py-0.5 rounded-full font-semibold">Hoàn điểm</span>`
                : isWin
                ? `<span class="badge-win  text-xs px-2 py-0.5 rounded-full font-semibold">✅ Thắng</span>`
                : `<span class="badge-lose text-xs px-2 py-0.5 rounded-full font-semibold">❌ Thua</span>`;

        const choiceLabel  = escapeHtml({ HOME: "Chủ nhà", DRAW: "Hòa", AWAY: "Khách" }[b.choice] || b.choice);
        const homeIconSrc  = safeImageSrc(b.home_icon);
        const awayIconSrc  = safeImageSrc(b.away_icon);
        const homeIconHtml = homeIconSrc ? `<img src="${homeIconSrc}" class="w-4 h-4 inline-block rounded-full mr-1">` : "";
        const awayIconHtml = awayIconSrc ? `<img src="${awayIconSrc}" class="w-4 h-4 inline-block rounded-full ml-1">` : "";
        const homeTeam     = escapeHtml(b.home_team);
        const awayTeam     = escapeHtml(b.away_team);
        const scoreOrVs    = isFinished
            ? `<span class="font-black text-slate-900">${b.home_score} - ${b.away_score}</span>`
            : `<span class="text-slate-400 font-bold">vs</span>`;

        return `
        <div>
            <div class="bet-card bg-white border border-slate-200 rounded-xl p-3 flex items-center gap-3 shadow-sm"
                 id="card-${b.bet_id}" onclick="toggleDetail(${b.bet_id})">
                <div class="flex-1 min-w-0">
                    <div class="flex items-center gap-1 text-sm font-semibold text-slate-900 mb-1 truncate">
                        ${homeIconHtml}${homeTeam}
                        <span class="mx-1 text-slate-400 text-xs font-normal">${scoreOrVs}</span>
                        ${awayTeam}${awayIconHtml}
                    </div>
                    <div class="flex items-center gap-2 text-xs text-slate-500">
                        <span>Chọn:</span>
                        <span class="font-medium text-slate-700">${choiceLabel}</span>
                        <span class="text-slate-300">•</span>
                        <span class="text-[#D3af37] font-semibold">${formatCoins(b.stake)}</span>
                    </div>
                </div>
                <div class="flex flex-col items-end gap-1 flex-shrink-0">
                    ${badgeHtml}
                    <svg id="arrow-${b.bet_id}" class="w-4 h-4 text-slate-400 transform transition-transform duration-200"
                         fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"/>
                    </svg>
                </div>
            </div>
            <div id="detail-${b.bet_id}" class="hidden detail-panel border-x border-b border-slate-200 rounded-b-xl px-4 pt-3 pb-4 -mt-1 bg-white shadow-sm">
                ${renderDetail(b)}
            </div>
        </div>`;
    }).join("");
}

function renderDetail(b) {
    const isFinished  = b.match_status === "finished";
    const isRefunded  = isFinished && b.points_earned === null;
    const isWin       = isFinished && b.points_earned > 0;
    const choiceLabel = escapeHtml({ HOME: "Chủ nhà 🏠", DRAW: "Hòa 🤝", AWAY: "Khách ✈️" }[b.choice] || b.choice);
    const homeTeam    = escapeHtml(b.home_team);
    const awayTeam    = escapeHtml(b.away_team);
    const hcSign      = b.handicap > 0 ? "+" : "";
    const fmt = dt => new Date(dt).toLocaleString("vi-VN", {
        day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit"
    });

    const resultHtml = isFinished
        ? isRefunded
            ? `<div class="flex justify-between"><span class="text-slate-500">Kết quả</span>
               <span class="font-semibold text-[#D3af37]">Hoàn ${formatCoins(b.stake)}</span></div>`
            : isWin
            ? `<div class="flex justify-between"><span class="text-slate-500">điểm nhận về</span>
               <span class="font-black text-[#D3af37] text-base">+${formatCoins(b.points_earned)}</span></div>`
            : `<div class="flex justify-between"><span class="text-slate-500">Kết quả</span>
               <span class="font-semibold text-[#D3af37]">Mất ${formatCoins(b.stake)}</span></div>`
        : `<div class="flex justify-between"><span class="text-slate-500">Kết quả</span>
           <span class="text-indigo-600 font-semibold">Đang chờ kết quả...</span></div>`;

    return `<div class="space-y-2 text-sm text-slate-700">
        <div class="flex justify-between"><span class="text-slate-500">Trận đấu</span><span class="font-semibold text-slate-900">${homeTeam} vs ${awayTeam}</span></div>
        <div class="flex justify-between"><span class="text-slate-500">Kèo chấp</span><span class="text-slate-700">${hcSign}${b.handicap}</span></div>
        ${isFinished ? `<div class="flex justify-between"><span class="text-slate-500">Tỉ số</span><span class="font-bold text-slate-900">${b.home_score} - ${b.away_score}</span></div>` : ""}
        <div class="flex justify-between"><span class="text-slate-500">Lựa chọn</span><span class="font-semibold text-sky-700">${choiceLabel}</span></div>
        <div class="flex justify-between"><span class="text-slate-500">Số điểm đặt</span><span class="text-[#D3af37] font-semibold">${formatCoins(b.stake)}</span></div>
        <div class="border-t border-slate-200 pt-2 mt-2">${resultHtml}</div>
        <div class="text-xs text-slate-400 pt-1">🗓 Trận: ${fmt(b.start_time)} &nbsp;•&nbsp; ⏱ Đặt: ${fmt(b.created_at)}</div>
    </div>`;
}

function toggleDetail(betId) {
    const detailEl = document.getElementById(`detail-${betId}`);
    const cardEl   = document.getElementById(`card-${betId}`);
    const arrowEl  = document.getElementById(`arrow-${betId}`);

    if (openCardId && openCardId !== betId) {
        document.getElementById(`detail-${openCardId}`)?.classList.add("hidden");
        document.getElementById(`card-${openCardId}`)?.classList.remove("active");
        document.getElementById(`arrow-${openCardId}`)?.classList.remove("rotate-180");
    }
    const isOpen = !detailEl.classList.contains("hidden");
    detailEl.classList.toggle("hidden", isOpen);
    cardEl.classList.toggle("active", !isOpen);
    arrowEl.classList.toggle("rotate-180", !isOpen);
    openCardId = isOpen ? null : betId;
}

async function fetchRechargeRequests() {
    const listEl = document.getElementById("recharge-list");
    if (!listEl) return;
    try {
        const res = await fetch("/api/v1/me/recharge-requests");
        if (!res.ok) {
            listEl.innerHTML = `<div class="text-sm text-red-400 py-3">Khong the tai yeu cau nap diem.</div>`;
            return;
        }
        _rechargeRequests = await res.json();
        renderRechargeRequests(_rechargeRequests);
    } catch (err) {
        console.error(err);
        listEl.innerHTML = `<div class="text-sm text-red-400 py-3">Loi ket noi.</div>`;
    }
}

function renderRechargeRequests(requests) {
    const listEl = document.getElementById("recharge-list");
    if (!listEl) return;
    if (!requests.length) {
        listEl.innerHTML = `<div class="text-sm text-slate-500 py-3">Chua co yeu cau nap diem.</div>`;
        return;
    }

    listEl.innerHTML = requests.slice(0, 5).map(item => {
        const isPending = item.status === "pending";
        const badge = isPending
            ? `<span class="text-xs px-2 py-0.5 rounded-full font-semibold bg-amber-50 text-amber-700 border border-amber-200">Dang cho</span>`
            : `<span class="text-xs px-2 py-0.5 rounded-full font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200">Da xac nhan</span>`;
        const time = new Date(item.created_at).toLocaleString("vi-VN", {
            day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit"
        });
        return `
            <div class="flex items-center justify-between gap-3 border border-slate-200 rounded-xl px-3 py-2 bg-slate-50">
                <div class="min-w-0">
                    <div class="font-black text-[#D3af37]">${Number(item.amount).toLocaleString()} diem</div>
                    <div class="text-xs text-slate-500">${escapeHtml(time)}</div>
                </div>
                ${badge}
            </div>`;
    }).join("");
}

function initRechargeModal() {
    const modal = document.getElementById("recharge-modal");
    const openBtn = document.getElementById("open-recharge-modal");
    const closeBtn = document.getElementById("close-recharge-modal");
    const cancelBtn = document.getElementById("btn-recharge-cancel");
    const saveBtn = document.getElementById("btn-recharge-save");
    const input = document.getElementById("recharge-amount");
    const errorEl = document.getElementById("recharge-error");
    if (!modal || !openBtn || !closeBtn || !cancelBtn || !saveBtn || !input || !errorEl) return;

    const open = () => {
        modal.classList.add("show");
        input.value = "";
        errorEl.classList.add("hidden");
        setTimeout(() => input.focus(), 80);
    };
    const close = () => modal.classList.remove("show");

    openBtn.addEventListener("click", open);
    closeBtn.addEventListener("click", close);
    cancelBtn.addEventListener("click", close);
    modal.addEventListener("click", e => { if (e.target === modal) close(); });

    saveBtn.addEventListener("click", async () => {
        const amount = Number(input.value);
        if (!Number.isInteger(amount) || amount < 100 || amount > 10000) {
            return showErr(errorEl, "Vui long nhap so diem tu 100 den 10000.");
        }

        saveBtn.disabled = true;
        const oldText = saveBtn.textContent;
        saveBtn.textContent = "Dang gui...";
        errorEl.classList.add("hidden");

        try {
            const res = await fetch("/api/v1/me/recharge-requests", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ amount }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.detail || `Loi ${res.status}`);
            close();
            await fetchRechargeRequests();
        } catch (err) {
            showErr(errorEl, err.message || "Khong the gui yeu cau nap diem.");
        } finally {
            saveBtn.disabled = false;
            saveBtn.textContent = oldText;
        }
    });

    input.addEventListener("keydown", e => { if (e.key === "Enter") saveBtn.click(); });
    document.addEventListener("keydown", e => {
        if (e.key === "Escape" && modal.classList.contains("show")) close();
    });
}
