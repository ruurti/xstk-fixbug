const state = {
    overview: null,
    settings: {
        topup_enabled: true,
        exchange_enabled: true,
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
        { label: "Lượt cược", value: formatNumber(state.overview.total_bets), tone: "text-pink-300" },
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
                    <div class="text-[11px] text-slate-500">${user.bet_count} lượt cược</div>
                </div>
            </div>
        </div>
    `).join("");
}

function renderOverviewFeatures() {
    const container = document.getElementById("overview-features");
    const items = [
        {
            label: "Nạp điểm",
            enabled: state.settings.topup_enabled,
            desc: state.settings.topup_enabled ? "Đang cho phép tạo yêu cầu nạp điểm." : "Đang khóa luồng tạo yêu cầu nạp điểm.",
        },
        {
            label: "Đổi điểm",
            enabled: state.settings.exchange_enabled,
            desc: state.settings.exchange_enabled ? "Đang mở tính năng đổi điểm." : "Đang khóa tính năng đổi điểm.",
        },
    ];

    container.innerHTML = items.map(item => `
        <div class="rounded-2xl border ${item.enabled ? "border-emerald-500/30 bg-emerald-500/8" : "border-rose-500/25 bg-rose-500/8"} px-4 py-4">
            <div class="flex items-center justify-between gap-3">
                <div>
                    <div class="font-semibold text-white">${item.label}</div>
                    <div class="mt-1 text-sm text-slate-400">${item.desc}</div>
                </div>
                <span class="rounded-full px-3 py-1 text-xs font-semibold ${item.enabled ? "bg-emerald-500/15 text-emerald-200" : "bg-rose-500/15 text-rose-200"}">
                    ${item.enabled ? "Đang bật" : "Đang tắt"}
                </span>
            </div>
        </div>
    `).join("");
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

function renderFeaturePills() {
    const container = document.getElementById("feature-status");
    container.innerHTML = [
        { label: "Nạp điểm", enabled: state.settings.topup_enabled },
        { label: "Đổi điểm", enabled: state.settings.exchange_enabled },
    ].map(item => `
        <span class="rounded-full border px-3 py-1 ${item.enabled ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-200" : "border-rose-500/30 bg-rose-500/10 text-rose-200"}">
            ${item.label}: ${item.enabled ? "Bật" : "Tắt"}
        </span>
    `).join("");
}

function renderSettings() {
    const list = document.getElementById("settings-list");
    const items = [
        {
            key: "topup_enabled",
            title: "Bật tính năng nạp điểm",
            desc: "Cho phép người dùng gửi yêu cầu nạp điểm mới.",
        },
        {
            key: "exchange_enabled",
            title: "Bật tính năng đổi điểm",
            desc: "Dành sẵn cho luồng đổi điểm phía người dùng.",
        },
    ];

    list.innerHTML = items.map(item => {
        const enabled = Boolean(state.settings[item.key]);
        return `
            <div class="rounded-2xl border border-slate-800 bg-slate-950/50 px-4 py-4">
                <div class="flex items-center justify-between gap-4">
                    <div>
                        <div class="font-semibold text-white">${item.title}</div>
                        <div class="mt-1 text-sm text-slate-400">${item.desc}</div>
                    </div>
                    <button type="button" class="switch shrink-0" data-setting-key="${item.key}" data-enabled="${enabled}">
                        <span class="switch-track block h-7 w-12 rounded-full bg-slate-700 p-1 transition">
                            <span class="switch-thumb block h-5 w-5 rounded-full bg-white transition"></span>
                        </span>
                    </button>
                </div>
            </div>
        `;
    }).join("");

    list.querySelectorAll("[data-setting-key]").forEach(btn => {
        btn.addEventListener("click", () => {
            const key = btn.dataset.settingKey;
            state.settings[key] = !state.settings[key];
            renderSettings();
            renderFeaturePills();
            renderOverviewFeatures();
        });
    });
}

async function saveSettings() {
    const btn = document.getElementById("save-settings");
    const oldText = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Đang lưu...";
    try {
        state.settings = await fetchJson("/api/v1/admin/settings", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(state.settings),
        });
        renderSettings();
        renderFeaturePills();
        renderOverviewFeatures();
        showToast("Đã cập nhật cài đặt tính năng.", "success");
    } catch (err) {
        showToast(err.message || "Không thể lưu cài đặt.", "error");
    } finally {
        btn.disabled = false;
        btn.textContent = oldText;
    }
}

async function fetchUsers(query = "") {
    try {
        const params = new URLSearchParams();
        if (query) params.set("q", query);
        state.users = await fetchJson(`/api/v1/admin/users${params.toString() ? `?${params}` : ""}`);
        renderUsers();
        renderOverviewUsers();
    } catch (err) {
        showToast(err.message || "Không thể tải danh sách user.", "error");
    }
}

function renderUsers() {
    const list = document.getElementById("admin-user-list");
    if (!state.users.length) {
        list.innerHTML = `<div class="glass-panel rounded-3xl px-5 py-6 text-sm text-slate-400">Không tìm thấy người dùng phù hợp.</div>`;
        return;
    }

    list.innerHTML = state.users.map(user => `
        <article class="glass-panel rounded-3xl p-5">
            <div class="flex flex-col gap-5 xl:flex-row xl:items-center xl:justify-between">
                <div class="min-w-0 flex-1">
                    <div class="flex flex-wrap items-center gap-2">
                        <h3 class="truncate text-lg font-bold text-white">${escapeHtml(user.display_name || user.email.split("@")[0])}</h3>
                        ${user.is_admin ? '<span class="rounded-full border border-sky-500/30 bg-sky-500/10 px-2 py-1 text-[11px] font-semibold text-sky-200">Admin</span>' : ""}
                    </div>
                    <p class="mt-1 truncate text-sm text-slate-400">${escapeHtml(user.email)}</p>
                    <div class="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                        <div class="rounded-2xl border border-slate-800 bg-slate-950/55 px-3 py-3">
                            <div class="text-[11px] uppercase tracking-[0.16em] text-slate-500">Điểm hiện tại</div>
                            <div class="mt-2 text-lg font-black text-amber-300">${formatCoins(user.total_points)}</div>
                        </div>
                        <div class="rounded-2xl border border-slate-800 bg-slate-950/55 px-3 py-3">
                            <div class="text-[11px] uppercase tracking-[0.16em] text-slate-500">Lượt cược</div>
                            <div class="mt-2 text-lg font-black text-emerald-300">${formatNumber(user.bet_count)}</div>
                        </div>
                        <div class="rounded-2xl border border-slate-800 bg-slate-950/55 px-3 py-3">
                            <div class="text-[11px] uppercase tracking-[0.16em] text-slate-500">Thắng / thua</div>
                            <div class="mt-2 text-lg font-black text-white">${formatNumber(user.win_count)} / ${formatNumber(user.loss_count)}</div>
                        </div>
                        <div class="rounded-2xl border border-slate-800 bg-slate-950/55 px-3 py-3">
                            <div class="text-[11px] uppercase tracking-[0.16em] text-slate-500">Lần cược cuối</div>
                            <div class="mt-2 text-sm font-semibold text-slate-200">${escapeHtml(formatDateTime(user.last_bet_at))}</div>
                        </div>
                    </div>
                </div>
                <div class="w-full xl:w-72">
                    <div class="rounded-2xl border border-slate-800 bg-slate-950/55 p-4">
                        <div class="text-sm font-semibold text-white">Cập nhật điểm</div>
                        <div class="mt-1 text-xs text-slate-500">Chỉnh trực tiếp số điểm hiện có của user.</div>
                        <div class="mt-4 flex gap-2">
                            <input id="points-input-${user.id}" class="user-points-input w-full rounded-2xl border border-slate-700 bg-slate-950 px-3 py-2.5 text-sm font-semibold text-white outline-none transition focus:border-emerald-500" type="number" min="0" value="${escapeHtml(user.total_points)}">
                            <button type="button" class="rounded-2xl bg-emerald-500 px-4 py-2.5 text-sm font-semibold text-slate-950 transition hover:bg-emerald-400" onclick="saveUserPoints('${user.id}')">Lưu</button>
                        </div>
                        <div class="mt-3 flex flex-wrap gap-2">
                            <button type="button" class="rounded-xl border border-slate-700 px-3 py-2 text-xs font-medium text-slate-300 transition hover:border-slate-500 hover:text-white" onclick="adjustUserPoints('${user.id}', 100)">+100</button>
                            <button type="button" class="rounded-xl border border-slate-700 px-3 py-2 text-xs font-medium text-slate-300 transition hover:border-slate-500 hover:text-white" onclick="adjustUserPoints('${user.id}', 500)">+500</button>
                            <button type="button" class="rounded-xl border border-slate-700 px-3 py-2 text-xs font-medium text-slate-300 transition hover:border-slate-500 hover:text-white" onclick="adjustUserPoints('${user.id}', -100)">-100</button>
                        </div>
                    </div>
                </div>
            </div>
        </article>
    `).join("");
}

function adjustUserPoints(userId, delta) {
    const input = document.getElementById(`points-input-${userId}`);
    if (!input) return;
    input.value = String(Math.max(0, Number(input.value || 0) + delta));
}

async function saveUserPoints(userId) {
    const input = document.getElementById(`points-input-${userId}`);
    if (!input) return;
    const total_points = Number(input.value);
    if (!Number.isFinite(total_points) || total_points < 0) {
        showToast("Số điểm không hợp lệ.", "error");
        return;
    }

    try {
        const data = await fetchJson(`/api/v1/admin/users/${userId}/points`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ total_points }),
        });
        state.users = state.users.map(user => user.id === userId ? { ...user, total_points: data.total_points } : user);
        renderUsers();
        renderOverviewUsers();
        await fetchOverview();
        showToast("Đã cập nhật điểm người dùng.", "success");
    } catch (err) {
        showToast(err.message || "Không thể cập nhật điểm.", "error");
    }
}

async function fetchRechargeRequests() {
    const list = document.getElementById("admin-recharge-list");
    try {
        state.rechargeRequests = await fetchJson("/api/v1/admin/recharge-requests");
        renderRechargeRequests();
    } catch (err) {
        list.innerHTML = `<div class="rounded-2xl border border-rose-500/25 bg-rose-500/10 px-4 py-4 text-sm text-rose-100">${escapeHtml(err.message || "Không thể tải yêu cầu nạp điểm.")}</div>`;
    }
}

function renderRechargeRequests() {
    const list = document.getElementById("admin-recharge-list");
    if (!state.rechargeRequests.length) {
        list.innerHTML = `<div class="rounded-2xl border border-slate-800 bg-slate-950/60 px-4 py-4 text-sm text-slate-400">Không có yêu cầu nạp điểm nào.</div>`;
        return;
    }

    list.innerHTML = state.rechargeRequests.map(item => {
        const user = item.user || {};
        const isPending = item.status === "pending";
        const badgeClass = isPending
            ? "border-amber-500/30 bg-amber-500/10 text-amber-200"
            : "border-emerald-500/30 bg-emerald-500/10 text-emerald-200";
        const badgeText = isPending ? "Đang chờ" : "Đã xác nhận";

        return `
            <div class="rounded-2xl border border-slate-800 bg-slate-950/55 px-4 py-4">
                <div class="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
                    <div class="min-w-0">
                        <div class="flex items-center gap-2">
                            ${renderMiniAvatar(user)}
                            <span class="truncate font-semibold text-white">${escapeHtml(user.display_name || user.email || "User")}</span>
                            <span class="rounded-full border px-2 py-1 text-[11px] font-semibold ${badgeClass}">${badgeText}</span>
                        </div>
                        <div class="mt-2 text-xs text-slate-400">${escapeHtml(user.email || "")} · #${item.id} · ${escapeHtml(formatDateTime(item.created_at))}</div>
                    </div>
                    <div class="flex items-center gap-3 md:justify-end">
                        <div class="text-right">
                            <div class="text-lg font-black text-amber-300">${formatCoins(item.amount)}</div>
                            <div class="text-xs text-slate-500">Số dư: ${formatCoins(user.total_points || 0)}</div>
                        </div>
                        <button type="button" onclick="approveRechargeRequest(${item.id})" ${isPending ? "" : "disabled"} class="rounded-xl bg-emerald-500 px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-40">
                            Xác nhận
                        </button>
                    </div>
                </div>
            </div>
        `;
    }).join("");
}

async function approveRechargeRequest(id) {
    const request = state.rechargeRequests.find(item => item.id === id);
    if (!request || request.status !== "pending") return;
    if (!confirm(`Xác nhận cộng ${formatCoins(request.amount)} cho ${request.user?.email || "user"}?`)) return;

    try {
        await fetchJson(`/api/v1/admin/recharge-requests/${id}/approve`, { method: "POST" });
        await Promise.all([fetchRechargeRequests(), fetchUsers(state.userSearch), fetchOverview()]);
        showToast("Đã xác nhận yêu cầu nạp điểm.", "success");
    } catch (err) {
        showToast(err.message || "Không thể xác nhận yêu cầu nạp điểm.", "error");
    }
}

function toDatetimeLocal(value) {
    if (!value) return "";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    const pad = n => String(n).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function getMatchPayload() {
    return {
        home_team: document.getElementById("home-team").value.trim(),
        away_team: document.getElementById("away-team").value.trim(),
        home_icon: document.getElementById("home-icon").value.trim() || null,
        away_icon: document.getElementById("away-icon").value.trim() || null,
        handicap: Number(document.getElementById("handicap").value || 0),
        status: document.getElementById("status").value,
        start_time: document.getElementById("start-time").value,
    };
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
    if (!state.matches.length) {
        list.innerHTML = `<div class="rounded-2xl border border-slate-800 bg-slate-950/60 px-4 py-4 text-sm text-slate-400">Không có trận đấu nào.</div>`;
        return;
    }

    list.innerHTML = state.matches.map(match => {
        const isFinished = match.status === "finished";
        const isLive = match.status === "live";
        const homeIconSrc = safeImageSrc(match.home_icon);
        const awayIconSrc = safeImageSrc(match.away_icon);
        const homeIconHtml = homeIconSrc ? `<img src="${homeIconSrc}" class="h-7 w-7 rounded-full border border-slate-700 object-cover" alt="">` : "";
        const awayIconHtml = awayIconSrc ? `<img src="${awayIconSrc}" class="h-7 w-7 rounded-full border border-slate-700 object-cover" alt="">` : "";
        const statusBadge = isLive
            ? `<span class="inline-flex items-center gap-1 rounded-full border border-rose-500/30 bg-rose-500/10 px-3 py-1 text-rose-200"><span class="h-2 w-2 rounded-full bg-rose-400 animate-pulse"></span>LIVE</span>`
            : `<span class="rounded-full border px-3 py-1 ${isFinished ? "border-slate-700 bg-slate-900 text-slate-300" : "border-emerald-500/30 bg-emerald-500/10 text-emerald-200"}">${escapeHtml(match.status)}</span>`;

        return `
            <article class="rounded-2xl border border-slate-800 bg-slate-950/55 p-5">
                <div class="flex flex-col gap-5 xl:flex-row xl:items-center xl:justify-between">
                    <div class="min-w-0 flex-1">
                        <div class="mb-4 flex flex-wrap items-center gap-2 text-xs">
                            ${statusBadge}
                            <span class="rounded-full border border-slate-700 bg-slate-900 px-3 py-1 text-slate-400">ID ${match.id}</span>
                            <span class="rounded-full border border-slate-700 bg-slate-900 px-3 py-1 text-slate-400">Kèo ${escapeHtml(match.handicap)}</span>
                            <span class="rounded-full border border-slate-700 bg-slate-900 px-3 py-1 text-slate-400">${escapeHtml(formatDateTime(match.start_time))}</span>
                        </div>

                        <div class="grid gap-4 md:grid-cols-[1fr_auto_1fr] md:items-center">
                            <div class="flex items-center gap-3 md:justify-end">
                                ${homeIconHtml}
                                <div class="text-lg font-bold text-white">${escapeHtml(match.home_team)}</div>
                            </div>
                            <div class="text-center text-xl font-black ${isFinished ? "text-amber-300" : "text-slate-500"}">
                                ${isFinished ? `${match.home_score} - ${match.away_score}` : "vs"}
                            </div>
                            <div class="flex items-center gap-3 md:justify-start">
                                <div class="text-lg font-bold text-white">${escapeHtml(match.away_team)}</div>
                                ${awayIconHtml}
                            </div>
                        </div>
                    </div>

                    <div class="w-full xl:w-auto">
                        <div class="flex flex-col gap-3">
                            <div class="flex flex-wrap justify-end gap-2">
                                <button type="button" onclick="editMatch(${match.id})" ${isFinished ? "disabled" : ""} class="rounded-xl border border-slate-700 px-3 py-2 text-sm font-semibold text-slate-200 transition hover:border-slate-500 hover:text-white disabled:cursor-not-allowed disabled:opacity-40">Sửa</button>
                                <button type="button" onclick="deleteMatch(${match.id})" ${isFinished ? "disabled" : ""} class="rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm font-semibold text-rose-200 transition hover:bg-rose-500/20 disabled:cursor-not-allowed disabled:opacity-40">Xóa</button>
                            </div>
                            ${isFinished ? `
                                <div class="rounded-2xl border border-amber-500/25 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">Trận đã được giải.</div>
                            ` : `
                                <div class="rounded-2xl border border-slate-800 bg-slate-900/80 p-4">
                                    <div class="mb-3 text-sm font-semibold text-white">Nhập tỉ số</div>
                                    <div class="flex items-center gap-2">
                                        <input id="home-score-${match.id}" type="number" min="0" placeholder="H" class="w-20 rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-center text-white outline-none transition focus:border-emerald-500">
                                        <span class="text-slate-500">-</span>
                                        <input id="away-score-${match.id}" type="number" min="0" placeholder="A" class="w-20 rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-center text-white outline-none transition focus:border-emerald-500">
                                        <button type="button" class="rounded-xl bg-indigo-500 px-4 py-2 text-sm font-semibold text-white transition hover:bg-indigo-400" onclick="resolveMatch(${match.id})">Giải trận</button>
                                    </div>
                                </div>
                            `}
                        </div>
                    </div>
                </div>
            </article>
        `;
    }).join("");
}

async function saveMatch(event) {
    event.preventDefault();
    const id = document.getElementById("match-id").value;
    const btn = document.getElementById("save-match-btn");
    const payload = getMatchPayload();
    if (!payload.home_team || !payload.away_team || !payload.start_time) {
        showToast("Vui lòng nhập đầy đủ đội nhà, đội khách và thời gian.", "error");
        return;
    }

    btn.disabled = true;
    const oldText = btn.textContent;
    btn.textContent = "Đang lưu...";
    try {
        const url = id ? `/api/v1/admin/matches/${id}/update` : "/api/v1/admin/matches";
        await fetchJson(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
        });
        resetMatchForm();
        await fetchMatches();
        showToast(id ? "Đã cập nhật trận đấu." : "Đã tạo trận đấu mới.", "success");
    } catch (err) {
        showToast(err.message || "Không thể lưu trận đấu.", "error");
    } finally {
        btn.disabled = false;
        btn.textContent = oldText;
    }
}

function showCsvImportResult(message, type = "success", errors = []) {
    const el = document.getElementById("csv-import-result");
    const errorHtml = errors.length
        ? `<ul class="mt-2 list-disc list-inside text-xs">${errors.map(err => `<li>Dòng ${escapeHtml(err.line)}: ${escapeHtml(err.error)}</li>`).join("")}</ul>`
        : "";
    el.className = `mt-3 rounded-2xl border px-4 py-3 text-sm ${
        type === "success"
            ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-100"
            : "border-rose-500/30 bg-rose-500/10 text-rose-100"
    }`;
    el.innerHTML = `${escapeHtml(message)}${errorHtml}`;
    el.classList.remove("hidden");
}

async function importMatchesCsv(event) {
    event.preventDefault();
    const fileInput = document.getElementById("csv-file");
    const btn = document.getElementById("csv-import-btn");
    const file = fileInput.files && fileInput.files[0];
    if (!file) {
        showCsvImportResult("Vui lòng chọn file CSV.", "error");
        return;
    }

    const formData = new FormData();
    formData.append("file", file);

    btn.disabled = true;
    const oldText = btn.textContent;
    btn.textContent = "Đang import...";
    try {
        const res = await fetch("/api/v1/admin/matches/import-csv", {
            method: "POST",
            body: formData,
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || data.errors?.length) {
            showCsvImportResult(data.message || data.detail || "Import CSV thất bại.", "error", data.errors || []);
            return;
        }
        showCsvImportResult(`${data.message} Tạo mới: ${data.created}, cập nhật: ${data.updated}.`, "success");
        fileInput.value = "";
        resetMatchForm();
        await fetchMatches();
    } catch (err) {
        showCsvImportResult("Đã xảy ra lỗi hệ thống khi import CSV.", "error");
    } finally {
        btn.disabled = false;
        btn.textContent = oldText;
    }
}

function editMatch(id) {
    const match = state.matches.find(item => item.id === id);
    if (!match || match.status === "finished") return;
    document.getElementById("match-id").value = match.id;
    document.getElementById("home-team").value = match.home_team;
    document.getElementById("away-team").value = match.away_team;
    document.getElementById("home-icon").value = match.home_icon || "";
    document.getElementById("away-icon").value = match.away_icon || "";
    document.getElementById("handicap").value = match.handicap;
    document.getElementById("status").value = match.status === "live" ? "live" : "upcoming";
    document.getElementById("start-time").value = toDatetimeLocal(match.start_time);
    document.getElementById("match-form-title").textContent = `Sửa trận #${match.id}`;
    document.getElementById("save-match-btn").textContent = "Cập nhật trận";
    document.getElementById("cancel-edit-btn").classList.remove("hidden");
    setActiveTab("matches");
    document.getElementById("home-team").focus();
}

function resetMatchForm() {
    document.getElementById("match-form").reset();
    document.getElementById("match-id").value = "";
    document.getElementById("handicap").value = "0";
    document.getElementById("status").value = "upcoming";
    document.getElementById("match-form-title").textContent = "Thêm trận đấu";
    document.getElementById("save-match-btn").textContent = "Lưu trận";
    document.getElementById("cancel-edit-btn").classList.add("hidden");
}

async function deleteMatch(id) {
    const match = state.matches.find(item => item.id === id);
    if (!match || match.status === "finished") return;
    if (!confirm(`Xóa trận ${match.home_team} vs ${match.away_team}?`)) return;

    try {
        await fetchJson(`/api/v1/admin/matches/${id}/delete`, { method: "POST" });
        if (document.getElementById("match-id").value === String(id)) resetMatchForm();
        await fetchMatches();
        showToast("Đã xóa trận đấu.", "success");
    } catch (err) {
        showToast(err.message || "Không thể xóa trận đấu.", "error");
    }
}

async function resolveMatch(id) {
    const homeScoreInput = document.getElementById(`home-score-${id}`);
    const awayScoreInput = document.getElementById(`away-score-${id}`);
    if (!homeScoreInput || !awayScoreInput || homeScoreInput.value === "" || awayScoreInput.value === "") {
        showToast("Vui lòng nhập đủ tỉ số hai đội.", "error");
        return;
    }

    try {
        const data = await fetchJson(`/api/v1/admin/resolve-match/${id}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                home_score: Number(homeScoreInput.value),
                away_score: Number(awayScoreInput.value),
            }),
        });
        await Promise.all([fetchMatches(), fetchOverview(), fetchUsers(state.userSearch)]);
        showToast(`Đã giải trận. Cửa thắng: ${data.winning_choice}.`, "success");
    } catch (err) {
        showToast(err.message || "Không thể giải trận.", "error");
    }
}

function showToast(message, type = "success") {
    const toast = document.getElementById("toast");
    toast.className = `rounded-2xl border px-4 py-3 text-sm font-medium ${
        type === "success"
            ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-100"
            : "border-rose-500/30 bg-rose-500/10 text-rose-100"
    }`;
    toast.textContent = message;
    toast.classList.remove("hidden");
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => toast.classList.add("hidden"), 3200);
}

window.adjustUserPoints = adjustUserPoints;
window.saveUserPoints = saveUserPoints;
window.approveRechargeRequest = approveRechargeRequest;
window.editMatch = editMatch;
window.deleteMatch = deleteMatch;
window.resolveMatch = resolveMatch;
