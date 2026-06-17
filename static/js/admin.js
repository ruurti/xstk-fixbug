const state = {
    overview: null,
    settings: {
        points_enabled: true,
    },
    users: [],
    matches: [],
    rechargeRequests: [],
    userSearch: "",
    activeTab: "overview",
    toastTimer: null,
};

document.addEventListener("DOMContentLoaded", () => {
    bindTabs();
    bindActions();
    document.getElementById("match-form")?.addEventListener("submit", saveMatch);
    document.getElementById("csv-import-form")?.addEventListener("submit", importMatchesCsv);
    fetchInitialData();
});

function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, ch => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        "\"": "&quot;",
        "'": "&#39;",
    }[ch]));
}

function safeImageSrc(value) {
    const src = String(value ?? "").trim();
    if (!src) return "";
    if (src.startsWith("/") || /^https?:\/\//i.test(src)) return escapeHtml(src);
    return "";
}

function safeCssColor(value) {
    const color = String(value ?? "").trim();
    return /^#[0-9a-f]{6}$/i.test(color) ? color : "#6366f1";
}

function formatNumber(value) {
    return Number(value || 0).toLocaleString("vi-VN");
}

function formatCoins(value) {
    return `${formatNumber(value)}đ`;
}

function formatDateTime(value) {
    if (!value) return "Chưa có dữ liệu";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "Không hợp lệ";
    return new Intl.DateTimeFormat("vi-VN", {
        hour: "2-digit",
        minute: "2-digit",
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
    }).format(date);
}

function normalizeMatchStatus(value) {
    const raw = typeof value === "string"
        ? value
        : value && typeof value === "object" && "value" in value
            ? value.value
            : value;
    return String(raw || "").toLowerCase();
}

function renderMiniAvatar({ avatar_url, avatar_color, initials }) {
    const avatarSrc = safeImageSrc(avatar_url);
    if (avatarSrc) {
        return `<img src="${avatarSrc}" alt="" class="h-6 w-6 rounded-full border border-emerald-500/30 object-cover">`;
    }
    return `<span class="inline-flex h-6 w-6 items-center justify-center rounded-full border border-emerald-500/30 text-[10px] font-black text-white" style="background:${safeCssColor(avatar_color)}">${escapeHtml(initials || "??")}</span>`;
}

function bindTabs() {
    document.querySelectorAll("[data-tab-target]").forEach(btn => {
        btn.addEventListener("click", () => setActiveTab(btn.dataset.tabTarget));
    });
}

function setActiveTab(tabName) {
    state.activeTab = tabName;
    document.querySelectorAll("[data-tab-target]").forEach(btn => {
        btn.classList.toggle("active", btn.dataset.tabTarget === tabName);
    });
    document.querySelectorAll("[data-tab-panel]").forEach(panel => {
        panel.classList.toggle("hidden", panel.dataset.tabPanel !== tabName);
    });
}

function bindActions() {
    document.getElementById("refresh-overview")?.addEventListener("click", refreshAll);
    document.getElementById("quick-refresh-users")?.addEventListener("click", () => fetchUsers(""));
    document.getElementById("refresh-users")?.addEventListener("click", () => fetchUsers(state.userSearch));
    document.getElementById("refresh-recharge")?.addEventListener("click", fetchRechargeRequests);
    document.getElementById("save-settings")?.addEventListener("click", saveSettings);
    document.getElementById("cancel-edit-btn")?.addEventListener("click", resetMatchForm);

    const searchInput = document.getElementById("user-search");
    let debounceTimer = null;
    searchInput?.addEventListener("input", event => {
        state.userSearch = event.target.value.trim();
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => fetchUsers(state.userSearch), 250);
    });
}

async function refreshAll() {
    await Promise.all([
        fetchOverview(),
        fetchSettings(),
        fetchUsers(state.userSearch),
        fetchRechargeRequests(),
        fetchMatches(),
    ]);
}

async function fetchInitialData() {
    await Promise.all([
        fetchMe(),
        refreshAll(),
    ]);
}

async function fetchJson(url, options = {}) {
    const res = await fetch(url, options);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
        throw new Error(data.detail || `Lỗi ${res.status}`);
    }
    return data;
}

async function fetchMe() {
    try {
        const data = await fetchJson("/api/v1/me");
        document.getElementById("user-info").innerHTML = `
            <div class="flex items-center gap-2">
                ${renderMiniAvatar(data)}
                <div class="min-w-0">
                    <div class="truncate font-semibold text-white">${escapeHtml(data.display_name || data.email.split("@")[0])}</div>
                    <div class="truncate text-[11px] text-slate-400">${escapeHtml(data.email)}</div>
                </div>
            </div>
        `;
    } catch (err) {
        showToast(err.message || "Không thể tải thông tin admin.", "error");
        document.getElementById("user-info").textContent = "Lỗi xác thực";
    }
}

async function fetchOverview() {
    try {
        state.overview = await fetchJson("/api/v1/admin/overview");
        renderOverview();
    } catch (err) {
        showToast(err.message || "Không thể tải tổng quan.", "error");
    }
}

function renderOverview() {
    if (!state.overview) return;
    const metrics = [
        { label: "Tổng user", value: formatNumber(state.overview.total_users), tone: "text-emerald-300" },
        { label: "Tổng điểm", value: formatCoins(state.overview.total_points), tone: "text-amber-300" },
        { label: "Trận đang mở", value: formatNumber(state.overview.upcoming_matches), tone: "text-sky-300" },
        { label: "Lịch sử báo nhà", value: formatNumber(state.overview.total_bets), tone: "text-pink-300" },
    ];

    document.getElementById("overview-metrics").innerHTML = metrics.map(metric => `
        <div class="metric-card rounded-3xl p-5">
            <div class="text-xs uppercase tracking-[0.2em] text-slate-400">${metric.label}</div>
            <div class="mt-4 text-3xl font-black ${metric.tone}">${metric.value}</div>
        </div>
    `).join("");

    renderOverviewUsers();
    renderOverviewFeatures();
}

function renderOverviewUsers() {
    const list = document.getElementById("overview-user-list");
    const items = state.users.slice(0, 5);
    if (!items.length) {
        list.innerHTML = `<div class="rounded-2xl border border-slate-800 bg-slate-950/60 px-4 py-4 text-sm text-slate-400">Chưa có người dùng nào.</div>`;
        return;
    }

    list.innerHTML = items.map(user => `
        <div class="rounded-2xl border border-slate-800 bg-slate-950/50 px-4 py-3">
            <div class="flex items-start justify-between gap-3">
                <div class="min-w-0">
                    <div class="truncate font-semibold text-white">${escapeHtml(user.display_name || user.email.split("@")[0])}</div>
                    <div class="truncate text-xs text-slate-400">${escapeHtml(user.email)}</div>
                </div>
                <div class="text-right">
                    <div class="text-sm font-bold text-amber-300">${formatCoins(user.total_points)}</div>
                    <div class="text-[11px] text-slate-500">${user.bet_count} Lịch sử báo nhà</div>
                </div>
            </div>
        </div>
    `).join("");
}

function renderOverviewFeatures() {
    const container = document.getElementById("overview-features");
    const enabled = Boolean(state.settings.points_enabled);
    container.innerHTML = `
        <div class="rounded-2xl border ${enabled ? "border-emerald-500/30 bg-emerald-500/8" : "border-rose-500/25 bg-rose-500/8"} px-4 py-4">
            <div class="flex items-center justify-between gap-3">
                <div>
                    <div class="font-semibold text-white">Nap / doi diem</div>
                    <div class="mt-1 text-sm text-slate-400">${enabled ? "Dang hien dong thoi block nap diem va doi diem tren profile." : "Dang an dong thoi block nap diem va doi diem tren profile."}</div>
                </div>
                <span class="rounded-full px-3 py-1 text-xs font-semibold ${enabled ? "bg-emerald-500/15 text-emerald-200" : "bg-rose-500/15 text-rose-200"}">
                    ${enabled ? "Dang bat" : "Dang tat"}
                </span>
            </div>
        </div>
    `;
}
function renderFeaturePills() {
    const container = document.getElementById("feature-status");
    const enabled = Boolean(state.settings.points_enabled);
    container.innerHTML = `
        <span class="rounded-full border px-3 py-1 ${enabled ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-200" : "border-rose-500/30 bg-rose-500/10 text-rose-200"}">
            Nap / doi diem: ${enabled ? "Bat" : "Tat"}
        </span>
    `;
}
function renderSettings() {
    const list = document.getElementById("settings-list");
    const enabled = Boolean(state.settings.points_enabled);
    list.innerHTML = `
        <div class="rounded-2xl border border-slate-800 bg-slate-950/50 px-4 py-4">
            <div class="flex items-center justify-between gap-4">
                <div>
                    <div class="font-semibold text-white">Bat block nap / doi diem</div>
                    <div class="mt-1 text-sm text-slate-400">Bat/tat dong thoi phan nap diem va doi diem tren trang profile.</div>
                </div>
                <button type="button" class="switch shrink-0" data-setting-key="points_enabled" data-enabled="${enabled}">
                    <span class="switch-track block h-7 w-12 rounded-full bg-slate-700 p-1 transition">
                        <span class="switch-thumb block h-5 w-5 rounded-full bg-white transition"></span>
                    </span>
                </button>
            </div>
        </div>
    `;
    list.querySelectorAll("[data-setting-key]").forEach(btn => {
        btn.addEventListener("click", () => {
            state.settings.points_enabled = !state.settings.points_enabled;
            renderSettings();
            renderFeaturePills();
            renderOverviewFeatures();
        });
    });
}

async function fetchSettings() {
    try {
        state.settings = await fetchJson("/api/v1/admin/settings");
        renderSettings();
        renderFeaturePills();
        renderOverviewFeatures();
    } catch (err) {
        showToast(err.message || "Không thể tải cài đặt.", "error");
    }
}

async function saveSettings() {
    const btn = document.getElementById("save-settings");
    const oldText = btn?.textContent;
    if (btn) {
        btn.disabled = true;
        btn.textContent = "Đang lưu...";
    }

    try {
        state.settings = await fetchJson("/api/v1/admin/settings", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ points_enabled: Boolean(state.settings.points_enabled) }),
        });
        renderSettings();
        renderFeaturePills();
        renderOverviewFeatures();
        showToast("Đã lưu cài đặt.", "success");
    } catch (err) {
        showToast(err.message || "Không thể lưu cài đặt.", "error");
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.textContent = oldText || "Lưu cài đặt";
        }
    }
}

async function fetchUsers(q = "") {
    try {
        const url = q ? `/api/v1/admin/users?q=${encodeURIComponent(q)}` : "/api/v1/admin/users";
        state.users = await fetchJson(url);
        renderUsers();
        renderOverviewUsers();
    } catch (err) {
        showToast(err.message || "Không thể tải danh sách người dùng.", "error");
    }
}

function renderUsers() {
    const list = document.getElementById("admin-user-list");
    if (!list) return;

    if (!state.users.length) {
        list.innerHTML = emptyPanel("Không tìm thấy người dùng nào.");
        return;
    }

    list.innerHTML = state.users.map(user => {
        const name = user.display_name || user.email.split("@")[0];
        const created = formatDateTime(user.created_at);
        const lastBet = user.last_bet_at ? formatDateTime(user.last_bet_at) : "Chưa đặt";
        return `
            <div class="glass-panel rounded-3xl p-5">
                <div class="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                    <div class="min-w-0">
                        <div class="flex flex-wrap items-center gap-2">
                            <h3 class="truncate text-lg font-bold text-white">${escapeHtml(name)}</h3>
                            ${user.is_admin ? `<span class="rounded-full border border-sky-500/30 bg-sky-500/10 px-2.5 py-1 text-xs font-semibold text-sky-200">Admin</span>` : ""}
                        </div>
                        <div class="mt-1 truncate text-sm text-slate-400">${escapeHtml(user.email)}</div>
                        <div class="mt-3 flex flex-wrap gap-2 text-xs text-slate-400">
                            <span class="rounded-full border border-slate-700 bg-slate-950/70 px-2.5 py-1">Tạo: ${escapeHtml(created)}</span>
                            <span class="rounded-full border border-slate-700 bg-slate-950/70 px-2.5 py-1">Bet: ${formatNumber(user.bet_count)}</span>
                            <span class="rounded-full border border-emerald-500/25 bg-emerald-500/10 px-2.5 py-1 text-emerald-200">Thắng: ${formatNumber(user.win_count)}</span>
                            <span class="rounded-full border border-rose-500/25 bg-rose-500/10 px-2.5 py-1 text-rose-200">Thua: ${formatNumber(user.loss_count)}</span>
                            <span class="rounded-full border border-slate-700 bg-slate-950/70 px-2.5 py-1">Gần nhất: ${escapeHtml(lastBet)}</span>
                        </div>
                    </div>
                    <form class="flex flex-col gap-2 sm:flex-row sm:items-center" onsubmit="return saveUserPoints(event, '${escapeHtml(user.id)}')">
                        <input
                            class="user-points-input w-full rounded-2xl border border-slate-700 bg-slate-950/80 px-4 py-2.5 text-sm font-bold text-amber-200 outline-none transition focus:border-amber-400 sm:w-40"
                            type="number"
                            min="0"
                            max="1000000000"
                            step="1"
                            value="${Number(user.total_points || 0)}"
                            aria-label="Tổng điểm"
                        >
                        <button type="submit" class="rounded-2xl bg-amber-400 px-4 py-2.5 text-sm font-semibold text-slate-950 transition hover:bg-amber-300">
                            Lưu điểm
                        </button>
                    </form>
                </div>
            </div>
        `;
    }).join("");
}

async function saveUserPoints(event, userId) {
    event.preventDefault();
    const form = event.currentTarget;
    const input = form.querySelector("input");
    const button = form.querySelector("button");
    const totalPoints = Number(input.value);

    if (!Number.isInteger(totalPoints) || totalPoints < 0 || totalPoints > 1_000_000_000) {
        showToast("Điểm phải là số nguyên từ 0 đến 1.000.000.000.", "error");
        return false;
    }

    const oldText = button.textContent;
    button.disabled = true;
    button.textContent = "Đang lưu...";
    try {
        const data = await fetchJson(`/api/v1/admin/users/${encodeURIComponent(userId)}/points`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ total_points: totalPoints }),
        });
        const user = state.users.find(item => item.id === data.id);
        if (user) user.total_points = data.total_points;
        renderUsers();
        renderOverviewUsers();
        await fetchOverview();
        showToast("Đã cập nhật điểm người dùng.", "success");
    } catch (err) {
        showToast(err.message || "Không thể cập nhật điểm.", "error");
    } finally {
        button.disabled = false;
        button.textContent = oldText;
    }
    return false;
}

async function fetchRechargeRequests() {
    try {
        state.rechargeRequests = await fetchJson("/api/v1/admin/recharge-requests");
        renderRechargeRequests();
    } catch (err) {
        showToast(err.message || "Không thể tải yêu cầu nạp điểm.", "error");
    }
}

function renderRechargeRequests() {
    const list = document.getElementById("admin-recharge-list");
    if (!list) return;

    if (!state.rechargeRequests.length) {
        list.innerHTML = emptyPanel("Chưa có yêu cầu nạp điểm.");
        return;
    }

    list.innerHTML = state.rechargeRequests.map(item => {
        const user = item.user || {};
        const isPending = item.status === "pending";
        return `
            <div class="rounded-3xl border border-slate-800 bg-slate-950/50 p-4">
                <div class="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
                    <div class="min-w-0">
                        <div class="flex flex-wrap items-center gap-2">
                            ${renderMiniAvatar(user)}
                            <div class="truncate font-semibold text-white">${escapeHtml(user.display_name || user.name || user.email || "User")}</div>
                            <span class="rounded-full border px-2.5 py-1 text-xs font-semibold ${isPending ? "border-amber-500/30 bg-amber-500/10 text-amber-200" : "border-emerald-500/30 bg-emerald-500/10 text-emerald-200"}">
                                ${isPending ? "Đang chờ" : "Đã duyệt"}
                            </span>
                        </div>
                        <div class="mt-2 truncate text-sm text-slate-400">${escapeHtml(user.email || "")}</div>
                        <div class="mt-2 text-xs text-slate-500">Tạo lúc ${escapeHtml(formatDateTime(item.created_at))}</div>
                    </div>
                    <div class="flex flex-col gap-2 sm:flex-row sm:items-center">
                        <div class="rounded-2xl border border-amber-500/25 bg-amber-500/10 px-4 py-2 text-right text-lg font-black text-amber-200">
                            ${formatCoins(item.amount)}
                        </div>
                        ${isPending ? `
                            <button type="button" class="rounded-2xl bg-emerald-500 px-4 py-2.5 text-sm font-semibold text-slate-950 transition hover:bg-emerald-400" onclick="approveRecharge(${item.id})">
                                Duyệt
                            </button>
                        ` : ""}
                    </div>
                </div>
            </div>
        `;
    }).join("");
}

async function approveRecharge(requestId) {
    if (!window.confirm(`Duyệt yêu cầu nạp điểm #${requestId}?`)) return;
    try {
        await fetchJson(`/api/v1/admin/recharge-requests/${requestId}/approve`, { method: "POST" });
        await Promise.all([fetchRechargeRequests(), fetchUsers(state.userSearch), fetchOverview()]);
        showToast("Đã duyệt yêu cầu nạp điểm.", "success");
    } catch (err) {
        showToast(err.message || "Không thể duyệt yêu cầu.", "error");
    }
}

async function fetchMatches() {
    try {
        state.matches = await fetchJson("/api/v1/admin/matches");
        renderMatches();
    } catch (err) {
        showToast(err.message || "Không thể tải danh sách trận đấu.", "error");
    }
}

function renderMatches() {
    const list = document.getElementById("admin-match-list");
    if (!list) return;

    if (!state.matches.length) {
        list.innerHTML = emptyPanel("Chưa có trận đấu nào.");
        return;
    }

    list.innerHTML = state.matches.map(match => {
        const status = normalizeMatchStatus(match.status);
        const canEdit = status !== "finished";
        const statusClass = status === "finished"
            ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-200"
            : status === "live"
                ? "border-rose-500/30 bg-rose-500/10 text-rose-200"
                : "border-sky-500/30 bg-sky-500/10 text-sky-200";
        return `
            <div class="glass-panel rounded-3xl p-5">
                <div class="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
                    <div class="min-w-0 flex-1">
                        <div class="flex flex-wrap items-center gap-2">
                            <h3 class="truncate text-lg font-black text-white">
                                ${teamLabel(match.home_team, match.home_icon)} <span class="text-slate-500">vs</span> ${teamLabel(match.away_team, match.away_icon)}
                            </h3>
                            <span class="rounded-full border px-2.5 py-1 text-xs font-semibold ${statusClass}">${escapeHtml(status)}</span>
                            ${match.result_published ? `<span class="rounded-full border border-amber-500/30 bg-amber-500/10 px-2.5 py-1 text-xs font-semibold text-amber-200">Đã giải</span>` : ""}
                        </div>
                        <div class="mt-3 grid gap-2 text-sm text-slate-400 sm:grid-cols-2 xl:grid-cols-4">
                            <div>Kèo: <span class="font-semibold text-white">${Number(match.handicap || 0)}</span></div>
                            <div>Bắt đầu: <span class="font-semibold text-white">${escapeHtml(formatDateTime(match.start_time))}</span></div>
                            <div>Kết thúc: <span class="font-semibold text-white">${escapeHtml(formatDateTime(match.end_time))}</span></div>
                            <div>Tỷ số: <span class="font-semibold text-white">${Number(match.home_score || 0)} - ${Number(match.away_score || 0)}</span></div>
                        </div>
                    </div>
                    <div class="flex flex-wrap gap-2 xl:justify-end">
                        ${canEdit ? `
                            <button type="button" class="rounded-2xl border border-sky-500/40 px-3 py-2 text-sm font-medium text-sky-200 transition hover:bg-sky-500/10" onclick="editMatch(${match.id})">Sửa</button>
                            <button type="button" class="rounded-2xl border border-rose-500/40 px-3 py-2 text-sm font-medium text-rose-200 transition hover:bg-rose-500/10" onclick="deleteMatch(${match.id})">Xóa</button>
                        ` : ""}
                        ${status === "finished" && !match.result_published ? resolveForm(match) : ""}
                    </div>
                </div>
            </div>
        `;
    }).join("");
}

function resolveForm(match) {
    return `
        <form class="flex flex-wrap items-center gap-2" onsubmit="return resolveMatch(event, ${match.id})">
            <input class="w-20 rounded-2xl border border-slate-700 bg-slate-950/80 px-3 py-2 text-sm text-white outline-none focus:border-emerald-500" type="number" min="0" step="1" value="${Number(match.home_score || 0)}" aria-label="Tỷ số đội nhà">
            <span class="text-slate-500">-</span>
            <input class="w-20 rounded-2xl border border-slate-700 bg-slate-950/80 px-3 py-2 text-sm text-white outline-none focus:border-emerald-500" type="number" min="0" step="1" value="${Number(match.away_score || 0)}" aria-label="Tỷ số đội khách">
            <button type="submit" class="rounded-2xl bg-emerald-500 px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-emerald-400">Giải trận</button>
        </form>
    `;
}

function teamLabel(name, icon) {
    const iconSrc = safeImageSrc(icon);
    const iconHtml = iconSrc ? `<img src="${iconSrc}" alt="" class="inline-block h-6 w-6 rounded-full border border-slate-700 object-cover align-middle">` : "";
    return `${iconHtml}<span class="align-middle">${escapeHtml(name)}</span>`;
}

function localDateTimeValue(value) {
    if (!value) return "";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    const pad = number => String(number).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function apiDateTimeValue(value) {
    return value ? value.replace("T", " ") + ":00" : "";
}

function readMatchPayload() {
    return {
        home_team: document.getElementById("home-team").value.trim(),
        away_team: document.getElementById("away-team").value.trim(),
        home_icon: document.getElementById("home-icon").value.trim() || null,
        away_icon: document.getElementById("away-icon").value.trim() || null,
        handicap: Number(document.getElementById("handicap").value || 0),
        status: document.getElementById("status").value,
        start_time: apiDateTimeValue(document.getElementById("start-time").value),
        end_time: apiDateTimeValue(document.getElementById("end-time").value),
    };
}

async function saveMatch(event) {
    event.preventDefault();
    const matchId = document.getElementById("match-id").value;
    const payload = readMatchPayload();

    if (!payload.home_team || !payload.away_team || !payload.start_time || !payload.end_time) {
        showToast("Vui lòng nhập đủ thông tin trận đấu.", "error");
        return;
    }

    const btn = document.getElementById("save-match-btn");
    const oldText = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Đang lưu...";
    try {
        const url = matchId ? `/api/v1/admin/matches/${matchId}/update` : "/api/v1/admin/matches";
        await fetchJson(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
        });
        resetMatchForm();
        await Promise.all([fetchMatches(), fetchOverview()]);
        showToast(matchId ? "Đã cập nhật trận đấu." : "Đã thêm trận đấu.", "success");
    } catch (err) {
        showToast(err.message || "Không thể lưu trận đấu.", "error");
    } finally {
        btn.disabled = false;
        btn.textContent = oldText;
    }
}

function editMatch(matchId) {
    const match = state.matches.find(item => Number(item.id) === Number(matchId));
    if (!match) return;
    document.getElementById("match-id").value = match.id;
    document.getElementById("home-team").value = match.home_team || "";
    document.getElementById("away-team").value = match.away_team || "";
    document.getElementById("home-icon").value = match.home_icon || "";
    document.getElementById("away-icon").value = match.away_icon || "";
    document.getElementById("handicap").value = Number(match.handicap || 0);
    document.getElementById("status").value = normalizeMatchStatus(match.status) === "live" ? "live" : "upcoming";
    document.getElementById("start-time").value = localDateTimeValue(match.start_time);
    document.getElementById("end-time").value = localDateTimeValue(match.end_time);
    document.getElementById("match-form-title").textContent = "Sửa trận đấu";
    document.getElementById("save-match-btn").textContent = "Cập nhật trận";
    document.getElementById("cancel-edit-btn").classList.remove("hidden");
    setActiveTab("matches");
    document.getElementById("match-form")?.scrollIntoView({ behavior: "smooth", block: "start" });
}

function resetMatchForm() {
    document.getElementById("match-form")?.reset();
    document.getElementById("match-id").value = "";
    document.getElementById("handicap").value = "0";
    document.getElementById("status").value = "upcoming";
    document.getElementById("match-form-title").textContent = "Thêm trận đấu";
    document.getElementById("save-match-btn").textContent = "Lưu trận";
    document.getElementById("cancel-edit-btn")?.classList.add("hidden");
}

async function deleteMatch(matchId) {
    if (!window.confirm(`Xóa trận #${matchId}?`)) return;
    try {
        await fetchJson(`/api/v1/admin/matches/${matchId}/delete`, { method: "POST" });
        await Promise.all([fetchMatches(), fetchOverview()]);
        showToast("Đã xóa trận đấu.", "success");
    } catch (err) {
        showToast(err.message || "Không thể xóa trận đấu.", "error");
    }
}

async function resolveMatch(event, matchId) {
    event.preventDefault();
    const form = event.currentTarget;
    const inputs = form.querySelectorAll("input");
    const homeScore = Number(inputs[0].value);
    const awayScore = Number(inputs[1].value);
    if (!Number.isInteger(homeScore) || homeScore < 0 || !Number.isInteger(awayScore) || awayScore < 0) {
        showToast("Tỷ số phải là số nguyên không âm.", "error");
        return false;
    }
    if (!window.confirm(`Giải trận #${matchId} với tỷ số ${homeScore} - ${awayScore}?`)) return false;

    try {
        const data = await fetchJson(`/api/v1/admin/resolve-match/${matchId}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ home_score: homeScore, away_score: awayScore }),
        });
        await Promise.all([fetchMatches(), fetchOverview(), fetchUsers(state.userSearch)]);
        showToast(data.message || "Đã giải trận.", "success");
    } catch (err) {
        showToast(err.message || "Không thể giải trận.", "error");
    }
    return false;
}

async function importMatchesCsv(event) {
    event.preventDefault();
    const input = document.getElementById("csv-file");
    const result = document.getElementById("csv-import-result");
    const btn = document.getElementById("csv-import-btn");
    const file = input?.files?.[0];

    if (!file) {
        showToast("Vui lòng chọn file CSV.", "error");
        return;
    }

    const oldText = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Đang import...";
    result.classList.add("hidden");

    try {
        const form = new FormData();
        form.append("file", file);
        const data = await fetchJson("/api/v1/admin/matches/import-csv", {
            method: "POST",
            body: form,
        });
        renderCsvImportResult(data);
        if (!data.errors?.length) {
            input.value = "";
            await Promise.all([fetchMatches(), fetchOverview()]);
            showToast(data.message || "Import CSV thành công.", "success");
        }
    } catch (err) {
        renderCsvImportResult({ message: err.message || "Import CSV thất bại.", errors: [] }, true);
    } finally {
        btn.disabled = false;
        btn.textContent = oldText;
    }
}

function renderCsvImportResult(data, forceError = false) {
    const result = document.getElementById("csv-import-result");
    if (!result) return;
    const hasErrors = forceError || Boolean(data.errors?.length);
    result.className = `mt-3 rounded-2xl border px-4 py-3 text-sm ${hasErrors ? "border-rose-500/30 bg-rose-500/10 text-rose-100" : "border-emerald-500/30 bg-emerald-500/10 text-emerald-100"}`;
    result.innerHTML = `
        <div class="font-semibold">${escapeHtml(data.message || "")}</div>
        ${data.imported !== undefined ? `<div class="mt-1 text-xs opacity-80">Imported: ${formatNumber(data.imported)} · Created: ${formatNumber(data.created)} · Updated: ${formatNumber(data.updated)}</div>` : ""}
        ${data.errors?.length ? `
            <div class="mt-3 space-y-1">
                ${data.errors.map(error => `<div>Dòng ${escapeHtml(error.line)}: ${escapeHtml(error.error)}</div>`).join("")}
            </div>
        ` : ""}
    `;
    result.classList.remove("hidden");
}

function emptyPanel(message) {
    return `<div class="rounded-2xl border border-slate-800 bg-slate-950/60 px-4 py-4 text-sm text-slate-400">${escapeHtml(message)}</div>`;
}

function showToast(message, tone = "success") {
    const toast = document.getElementById("toast");
    if (!toast) return;
    clearTimeout(state.toastTimer);
    toast.textContent = message;
    toast.className = `rounded-2xl border px-4 py-3 text-sm font-medium ${
        tone === "error"
            ? "border-rose-500/30 bg-rose-500/10 text-rose-100"
            : "border-emerald-500/30 bg-emerald-500/10 text-emerald-100"
    }`;
    toast.classList.remove("hidden");
    state.toastTimer = setTimeout(() => toast.classList.add("hidden"), 3500);
}
