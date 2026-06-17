// ─── State ───────────────────────────────────────────────────────────────────
let currentUser = null;          // { email, total_points }
let placedBets = new Set();      // match IDs đã cược trong session này
let matchDetailCache = new Map();
const NO_CACHE_FETCH_OPTIONS = { cache: "no-store" };
const MIN_STAKE = 10;
const QUICK_STAKE_OPTIONS = [100, 200, 500, 1000];

// Bảng màu avatar — hash từ tên để màu ổn định
const AVATAR_COLORS = [
    "#7c3aed","#db2777","#0891b2","#059669","#d97706",
    "#dc2626","#2563eb","#7c3aed","#0d9488","#9333ea",
];

function nameToColor(name) {
    let h = 0;
    for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
    return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

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

function formatCoins(value) {
    return `${Number(value || 0).toLocaleString()}đ`;
}

function renderLeaderboardAvatar(entry, className = "lb-avatar") {
    const avatarSrc = safeImageSrc(entry.avatar_url);
    const initials = escapeHtml(entry.initials || (String(entry.name ?? "").slice(0, 2).toUpperCase() || "??"));
    const bg = safeCssColor(entry.avatar_color) || nameToColor(String(entry.name ?? ""));
    if (avatarSrc) {
        return `<img src="${avatarSrc}" alt="" class="${className} object-cover border border-slate-200 flex-shrink-0">`;
    }
    return `<span class="${className} flex items-center justify-center text-sm font-black text-white flex-shrink-0" style="background:${bg}">${initials}</span>`;
}

function renderMiniAvatar({ avatar_url, avatar_color, initials }) {
    const avatarSrc = safeImageSrc(avatar_url);
    if (avatarSrc) {
        return `<img src="${avatarSrc}" alt="" class="w-5 h-5 rounded-full object-cover border border-sky-300 flex-shrink-0">`;
    }
    return `<span class="w-5 h-5 rounded-full border border-sky-300 flex items-center justify-center text-[9px] font-black text-white flex-shrink-0" style="background:${safeCssColor(avatar_color)}">${escapeHtml(initials || "??")}</span>`;
}

function renderBettorAvatar(bettor, className = "w-7 h-7") {
    const avatarSrc = safeImageSrc(bettor.avatar_url);
    if (avatarSrc) {
        return `<img src="${avatarSrc}" alt="" class="${className} rounded-full object-cover border border-slate-200 flex-shrink-0">`;
    }
    return `<span class="${className} rounded-full border border-slate-200 flex items-center justify-center text-[11px] font-black text-white flex-shrink-0" style="background:${safeCssColor(bettor.avatar_color)}">${escapeHtml(bettor.initials || "??")}</span>`;
}

const DETAIL_QUOTES = [
    "Đám đông có thể ồn, nhưng quỹ luôn thích chỗ biết thắng.",
    "Cửa ít người vào không có nghĩa là yếu, đôi khi là biết giữ tiền hơn.",
    "Ai cũng thích đi theo số đông, còn tiền thì thích đi theo người tỉnh.",
    "Cửa kia đông thật, nhưng ví tiền không ký hợp đồng với đám đông.",
    "Hôm nay không cần hô to, chỉ cần vào đúng cửa rồi ngồi nhìn tỉ số.",
    "Chọn khôn một nhịp, khịa nhẹ cả phòng.",
];

function choiceLabel(choice) {
    return { HOME: "Chủ nhà", DRAW: "Hòa", AWAY: "Khách" }[choice] || choice;
}

function isLiveMatch(match) {
    return String(match?.status || "").toLowerCase() === "live";
}

function formatVNDateTime(value) {
    if (!value) return "—";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "—";
    return date.toLocaleString("vi-VN", {
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
    });
}

function getQuoteByDetail(detail) {
    const pool = detail?.pool || {};
    const stakeMap = [
        ["HOME", Number(pool.home_stakes || 0)],
        ["DRAW", Number(pool.draw_stakes || 0)],
        ["AWAY", Number(pool.away_stakes || 0)],
    ].sort((a, b) => b[1] - a[1]);
    const dominant = stakeMap[0]?.[0] || "HOME";
    const quoteSets = {
        HOME: [
            "Cửa chủ nhà đang có khí thế, nhưng đừng để cái ồn che mất cái khôn.",
            "Đám đông đang nghiêng về chủ nhà, còn ai tỉnh thì vẫn biết quỹ thích gì.",
        ],
        DRAW: [
            "Kèo hòa thường rất lì, nhìn hiền mà dễ làm cả bọn im lặng.",
            "Cửa hòa không ầm ĩ, nhưng lúc nổ thì ai cũng phải nhìn lại.",
        ],
        AWAY: [
            "Cửa khách mà ít người vào thì lại càng có chất riêng.",
            "Thích đi ngược đám đông à? Cửa khách đang chờ người có gan.",
        ],
    };
    const poolQuotes = quoteSets[dominant] || DETAIL_QUOTES;
    return poolQuotes[Math.floor(Math.random() * poolQuotes.length)];
}

document.addEventListener("DOMContentLoaded", () => {
    fetchUserProfile();
    fetchUpcomingMatches();
    fetchLatestFinishedMatch();
    startTicker();
    fetchLeaderboard();
    document.getElementById("match-detail-modal")?.addEventListener("click", e => {
        if (e.target && e.target.id === "match-detail-modal") closeMatchDetail();
    });
    document.addEventListener("keydown", e => {
        if (e.key === "Escape") closeMatchDetail();
    });
    // Refresh pool odds mỗi 30 giây
    setInterval(fetchUpcomingMatches, 30_000);
    setInterval(fetchLatestFinishedMatch, 30_000);
    // Refresh ticker mỗi 60 giây
    setInterval(startTicker, 60_000);
});


// ─── 1. User Profile ──────────────────────────────────────────────────────────
async function fetchUserProfile() {
    const el = document.getElementById("user-info");
    try {
        const res = await fetch("/api/v1/me", NO_CACHE_FETCH_OPTIONS);
        if (!res.ok) throw new Error();
        currentUser = await res.json();
        renderUserInfo();
        fetchUpcomingMatches();
    } catch {
        el.innerHTML = `<span class="text-red-400 font-medium">Lỗi kết nối Auth</span>`;
    }
}

function renderUserInfo() {
    const el = document.getElementById("user-info");
    if (!currentUser) return;
    const shortEmail = currentUser.email.split("@")[0];
    const displayName = currentUser.display_name || shortEmail;
    el.title = currentUser.email;
    el.innerHTML = `
        <span class="inline-flex items-center gap-2 max-w-full">
            ${renderMiniAvatar(currentUser)}
            <span class="font-semibold text-slate-900 truncate max-w-[8rem]">${escapeHtml(displayName)}</span>
            <span class="text-slate-300">|</span>
            <span class="text-[#D3af37] font-bold" id="user-points">${currentUser.total_points.toLocaleString()}</span><span class="text-[#D3af37]">d</span>
        </span>`;

    document.getElementById("admin-header-link")?.classList.toggle("hidden", !currentUser.is_admin);
    document.getElementById("admin-nav-link")?.classList.toggle("hidden", !currentUser.is_admin);
}

function updateDisplayedPoints(newTotal) {
    if (currentUser) currentUser.total_points = newTotal;
    const el = document.getElementById("user-points");
    if (el) el.textContent = newTotal.toLocaleString();
}


// ─── 2. Match List ────────────────────────────────────────────────────────────
async function fetchUpcomingMatches() {
    const listEl = document.getElementById("match-list");
    try {
        matchDetailCache.clear();
        const res = await fetch("/api/v1/matches", NO_CACHE_FETCH_OPTIONS);
        const matches = await res.json();

        if (!matches.length) {
            listEl.innerHTML = `<div class="text-center py-12 text-slate-500 text-sm">Hiện chưa có trận đấu nào đang mở cược.</div>`;
            return;
        }

        // Group theo ngày
        const grouped = {};
        matches.forEach(m => {
            const d = new Date(m.start_time);
            const key = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
            (grouped[key] = grouped[key] || []).push(m);
        });

        const sortedDates = Object.keys(grouped).sort();
        let html = "";

        sortedDates.forEach((dateKey, idx) => {
            const dateMatches = grouped[dateKey];
            const displayDate = dateKey.split("-").reverse().join("/");
            const expanded = idx === 0;

            const matchesHtml = dateMatches.map(m => renderMatchCard(m)).join("");

            html += `
                <div class="mb-4">
                    <button onclick="toggleGroup('${dateKey}')" class="w-full flex justify-between items-center bg-white p-3 rounded-lg border border-slate-200 focus:outline-none mb-2 active:bg-sky-50 shadow-sm">
                        <span class="font-bold text-sky-700 text-sm">📅 Ngày ${displayDate} <span class="text-slate-500 text-xs font-normal">(${dateMatches.length} trận)</span></span>
                        <svg id="icon-${dateKey}" class="w-5 h-5 text-slate-400 transform transition-transform duration-200 ${expanded ? "rotate-180" : ""}" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"></path>
                        </svg>
                    </button>
                    <div id="content-${dateKey}" class="${expanded ? "" : "hidden"}">
                        ${matchesHtml}
                    </div>
                </div>`;
        });

        listEl.innerHTML = html;

        // Sau khi render xong, fetch avatar stacks cho tất cả trận
        matches.forEach(m => fetchAvatarStack(m.id));

    } catch (e) {
        console.error(e);
        listEl.innerHTML = `<div class="text-center py-8 text-red-400 text-xs">Không thể tải danh sách trận đấu. Vui lòng thử lại sau!</div>`;
    }
}

async function fetchLatestFinishedMatch() {
    const el = document.getElementById("latest-finished-body");
    if (!el) return;
    try {
        const res = await fetch("/api/v1/matches/latest-finished/detail", NO_CACHE_FETCH_OPTIONS);
        if (res.status === 404) {
            el.innerHTML = `<div class="rounded-xl border border-slate-200 bg-white p-4 text-sm text-slate-500 shadow-sm">Chưa có trận nào hoàn tất.</div>`;
            return;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const details = Array.isArray(data) ? data : [data];
        el.innerHTML = renderLatestFinishedMatches(details);
    } catch (e) {
        console.error(e);
        el.innerHTML = `<div class="rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700">Không tải được danh sách trận đã hoàn tất.</div>`;
    }
}




// ─── 4. Avatar Stack ──────────────────────────────────────────────────────────
async function fetchAvatarStack(matchId) {
    try {
        const res = await fetch(`/api/v1/matches/${matchId}/bets`, NO_CACHE_FETCH_OPTIONS);
        if (!res.ok) return;
        const data = await res.json();
        ["HOME", "DRAW", "AWAY"].forEach(choice => {
            const slot = document.getElementById(`avatars-${choice.toLowerCase()}-${matchId}`);
            if (!slot) return;
            renderAvatarStack(slot, data[choice] || []);
        });
    } catch(e) {
        // Silently fail – avatar stack is non-critical
    }
}

function renderAvatarStack(container, bettors) {
    if (!bettors.length) {
        container.innerHTML = `<span class="text-gray-600 text-xs">—</span>`;
        return;
    }

    const MAX_SHOW = 5;
    const shown = bettors.slice(0, MAX_SHOW);
    const extra = bettors.length - MAX_SHOW;

    // Build từ phải sang trái (do flex-direction: row-reverse)
    let avatarsHtml = shown.map(b => {
        const rawName = String(b.name ?? "");
        const lwClass = b.is_lone_wolf ? " lone-wolf" : "";
        const lwIcon  = b.is_lone_wolf ? `<span style="position:absolute;top:-7px;right:-3px;font-size:0.6rem;line-height:1">👑</span>` : "";
        const title = escapeHtml(
            b.is_lone_wolf
                ? `${rawName} — Kẻ đi ngược đám đông! (${formatCoins(b.stake)})`
                : `${rawName} (${formatCoins(b.stake)})`
        );
        const avatar = renderBettorAvatar(b, "w-full h-full");
        return `<div class="avatar-circle${lwClass}" title="${title}">${lwIcon}${avatar}</div>`;
    }).join("");

    if (extra > 0) {
        avatarsHtml += `<div class="avatar-more">+${extra}</div>`;
    }

    container.innerHTML = `<div class="avatar-stack">${avatarsHtml}</div>`;
}


// ─── 5. Tính điểm thưởng dự kiến ───────────────────────────────────────────────
function estimateReward(totalPool, choicePool, stake) {
    const pool = Math.max(0, Number(totalPool) || 0);
    const choice = Math.max(0, Number(choicePool) || 0);
    const bet = Math.max(0, Number(stake) || 0);
    if (bet <= 0) return 0;
    return Math.floor(((pool + bet) * bet) / (choice + bet));
}

function renderLatestFinishedMatch(detail) {
    const match = detail.match || {};
    const settlement = detail.settlement || {};
    const pool = detail.pool || {};
    const isPublished = Boolean(settlement.result_published);
    const totalPool = Number(pool.total_pool || 0);
    const winnerText = !isPublished
        ? "Chờ kết quả"
        : settlement.refunded
        ? "Hoàn điểm"
        : choiceLabel(settlement.winning_choice);
    const scoreText = isPublished ? (settlement.score || `${match.home_score ?? 0}-${match.away_score ?? 0}`) : "Chờ kết quả";
    const adjustedText = isPublished && settlement.adjusted_score ? `Sau kèo ${settlement.adjusted_score}` : "Đang chờ công bố";
    const winnerCount = Number(settlement.winner_count || 0);
    const loserCount = Number(settlement.loser_count || 0);
    const refundCount = Number(settlement.refund_count || 0);

    return `
        <div class="space-y-4">
            <div class="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                <div class="min-w-0">
                    <div class="text-[11px] uppercase tracking-[0.18em] text-slate-500">${isPublished ? "Trận đã hoàn tất gần nhất" : "Trận chờ kết quả gần nhất"}</div>
                    <div class="mt-1 text-lg font-black text-slate-900 truncate">${escapeHtml(match.home_team || "Trận đấu")} vs ${escapeHtml(match.away_team || "")}</div>
                    <div class="mt-1 text-sm text-slate-500">${escapeHtml(scoreText)} · ${escapeHtml(adjustedText)} · ${formatVNDateTime(match.start_time)}</div>
                </div>
            <div class="flex items-center gap-2 flex-wrap justify-end">
                <span class="inline-flex items-center rounded-full border px-3 py-1 text-xs font-semibold ${!isPublished ? "border-slate-200 bg-slate-50 text-slate-600" : settlement.refunded ? "border-amber-200 bg-amber-50 text-amber-700" : "border-emerald-200 bg-emerald-50 text-emerald-700"}">
                    ${escapeHtml(!isPublished ? "Chờ kết quả" : settlement.refunded ? "Hoàn điểm" : `Cửa thắng: ${winnerText}`)}
                </span>
                    <button type="button" onclick="openMatchDetail(${match.id}, true)" class="inline-flex items-center gap-2 rounded-full border border-sky-200 bg-sky-50 px-3 py-1.5 text-xs font-semibold text-sky-700 hover:bg-sky-100 transition-colors">
                        🔎Chi tiết
                    </button>
                </div>
            </div>

            ${isPublished ? `
                <div class="grid grid-cols-2 md:grid-cols-4 gap-3">
                    ${summaryTile("Tổng quỹ", formatCoins(totalPool), "text-[#D3af37]")}
                    ${summaryTile("Người thắng", String(winnerCount), "text-emerald-600")}
                    ${summaryTile("Người thua", String(loserCount), "text-rose-600")}
                    ${summaryTile(settlement.refunded ? "Hoàn điểm" : "Cửa thắng", settlement.refunded ? String(refundCount) : winnerText, "text-[#D3af37]")}
                </div>
            ` : `
                <div class="rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600">
                    Trận đã kết thúc theo lịch và đang chờ công bố kết quả chính thức.
                </div>
                <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
                    ${summaryTile("Tổng quỹ", formatCoins(totalPool), "text-[#D3af37]")}
                    ${summaryTile("Trạng thái", "Chờ kết quả", "text-slate-600")}
                </div>
            `}

            <div class="rounded-xl border border-amber-200 bg-amber-50 p-4">
                <div class="text-[11px] uppercase tracking-wide text-amber-700">Ý kiến của chuyên gia</div>
                <div class="mt-2 text-sm leading-relaxed text-amber-900 italic">${escapeHtml(settlement.headline_quote || getQuoteByDetail(detail))}</div>
            </div>
        </div>`;
}

function renderLatestFinishedMatches(details) {
    if (!details.length) {
        return `<div class="rounded-xl border border-slate-200 bg-white p-4 text-sm text-slate-500 shadow-sm">Chưa có trận nào hoàn tất.</div>`;
    }
    return `<div class="space-y-4">${details.map(renderLatestFinishedMatch).join("")}</div>`;
}




// ─── 9. Toggle Accordion ─────────────────────────────────────────────────────
window.openMatchDetail = async function(matchId, forceFresh = false) {
    const modal = document.getElementById("match-detail-modal");
    const body = document.getElementById("match-detail-body");
    if (!modal || !body) return;

    modal.classList.remove("hidden");
    document.body.style.overflow = "hidden";
    body.innerHTML = `
        <div class="flex items-center justify-center py-12 text-slate-500">
            <div class="animate-pulse">Đang tải chi tiết trận...</div>
        </div>`;

    try {
        const cached = forceFresh ? null : matchDetailCache.get(matchId);
        const response = cached ? null : await fetch(`/api/v1/matches/${matchId}/detail`, NO_CACHE_FETCH_OPTIONS);
        if (response && !response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }
        const data = cached || await response.json();
        if (!cached) matchDetailCache.set(matchId, data);
        renderMatchDetail(data);
    } catch (err) {
        console.error(err);
        body.innerHTML = `
            <div class="rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700">
                Không thể tải chi tiết trận lúc này.
            </div>`;
    }
};

window.closeMatchDetail = function() {
    const modal = document.getElementById("match-detail-modal");
    if (modal) modal.classList.add("hidden");
    document.body.style.overflow = "";
};

function renderMatchDetail(detail) {
    const body = document.getElementById("match-detail-body");
    const titleEl = document.getElementById("match-detail-title");
    const subtitleEl = document.getElementById("match-detail-subtitle");
    const quoteEl = document.getElementById("match-detail-quote");
    if (!body || !titleEl || !subtitleEl || !quoteEl) return;

    const match = detail.match || {};
    const pool = detail.pool || {};
    const settlement = detail.settlement || {};
    const bettors = detail.bettors || {};
    const myBet = detail.my_bet;
    const totalPool = Number(pool.total_pool || 0);
    const resultPublished = Boolean(settlement.result_published);
    const choiceStats = [
        { key: "HOME", stake: Number(pool.home_stakes || 0), count: Number(pool.home_count || 0), bettors: bettors.HOME || [] },
        { key: "DRAW", stake: Number(pool.draw_stakes || 0), count: Number(pool.draw_count || 0), bettors: bettors.DRAW || [] },
        { key: "AWAY", stake: Number(pool.away_stakes || 0), count: Number(pool.away_count || 0), bettors: bettors.AWAY || [] },
    ];

    titleEl.textContent = `${match.home_team} vs ${match.away_team}`;
    subtitleEl.textContent = resultPublished
        ? `Kèo chấp ${match.handicap ?? 0} | Tỷ số ${settlement.score || `${match.home_score ?? 0}-${match.away_score ?? 0}`} | Sau kèo ${settlement.adjusted_score || "--"}`
        : settlement.is_finished
        ? `Kèo chấp ${match.handicap ?? 0} | Kết thúc ${formatVNDateTime(match.end_time)} | Chờ kết quả`
        : `Kèo chấp ${match.handicap ?? 0} | Bắt đầu ${formatVNDateTime(match.start_time)} | Kết thúc ${formatVNDateTime(match.end_time)} | Trạng thái ${match.status}`;
    quoteEl.textContent = settlement.headline_quote || getQuoteByDetail(detail);

    const homePct = totalPool > 0 ? (choiceStats[0].stake / totalPool) * 100 : 0;
    const drawPct = totalPool > 0 ? (choiceStats[1].stake / totalPool) * 100 : 0;
    const awayPct = totalPool > 0 ? (choiceStats[2].stake / totalPool) * 100 : 0;

    body.innerHTML = `
        <div class="grid grid-cols-2 md:grid-cols-4 gap-3">
            ${summaryTile("Tổng quỹ", formatCoins(totalPool), "text-[#D3af37]")}
            ${summaryTile("Chủ nhà", formatCoins(choiceStats[0].stake), "text-[#D3af37]")}
            ${summaryTile("Hòa", formatCoins(choiceStats[1].stake), "text-[#D3af37]")}
            ${summaryTile("Khách", formatCoins(choiceStats[2].stake), "text-[#D3af37]")}
        </div>

        ${resultPublished ? `
            <div class="grid grid-cols-2 md:grid-cols-4 gap-3">
                ${summaryTile("Kết quả", settlement.score || `${match.home_score ?? 0}-${match.away_score ?? 0}`, "text-[#D3af37]")}
                ${summaryTile("Sau kèo", settlement.adjusted_score || "--", "text-[#D3af37]")}
                ${summaryTile("Người thắng", String(Number(settlement.winner_count || 0)), "text-[#D3af37]")}
                ${summaryTile(settlement.refunded ? "Hoàn điểm" : "Cửa thắng", settlement.refunded ? String(Number(settlement.refund_count || 0)) : choiceLabel(settlement.winning_choice), "text-[#D3af37]")}
            </div>
        ` : settlement.is_finished ? `
            <div class="rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600">
                Trận đã kết thúc và đang chờ công bố kết quả chính thức.
            </div>
        ` : ""}

        <div class="grid grid-cols-1 md:grid-cols-3 gap-3">
            ${renderChoiceColumn(choiceStats[0], homePct, settlement)}
            ${renderChoiceColumn(choiceStats[1], drawPct, settlement)}
            ${renderChoiceColumn(choiceStats[2], awayPct, settlement)}
        </div>

        <div class="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
            <div class="flex items-center justify-between gap-3 mb-3">
                <div>
                    <div class="text-xs uppercase tracking-wide text-slate-500">Cửa của bạn</div>
                    <div class="text-sm font-semibold text-slate-900">${myBet ? choiceLabel(myBet.choice) : "Chưa vào cửa"}</div>
                </div>
                <div class="text-right">
                    <div class="text-xs text-slate-500">điểm đã vào</div>
                    <div class="text-lg font-black text-[#D3af37]">${myBet ? formatCoins(myBet.stake) : "0d"}</div>
                    ${myBet ? `<div class="text-[11px] text-[#D3af37]">${escapeHtml(myBet.reward_label || myBet.outcome_label || "")}</div>` : ""}
                </div>
            </div>
            ${myBet ? `<div class="text-xs text-slate-500">${escapeHtml(myBet.quote || "Vào đúng cửa thì uống trà, vào lệch cửa thì ngồi ngẫm đời.")}</div>` : `<div class="text-xs text-slate-500">Chưa đặt cược vẫn xem được quỹ và danh sách để cân nhắc cửa vào.</div>`}
        </div>
    `;
}

function summaryTile(label, value, valueClass) {
    return `
        <div class="rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
            <div class="text-[11px] uppercase tracking-wide text-slate-500">${escapeHtml(label)}</div>
            <div class="mt-1 text-sm font-black ${valueClass}">${escapeHtml(value)}</div>
        </div>`;
}

function renderChoiceColumn(choiceStat, pct, settlement) {
    const list = choiceStat.bettors || [];
    const state = getChoiceState(choiceStat.key, settlement);
    return `
        <section class="rounded-xl border border-slate-200 bg-white p-4 flex flex-col gap-3 shadow-sm">
            <div class="flex items-center justify-between gap-2">
                <div>
                    <div class="text-xs uppercase tracking-wide text-slate-500">${escapeHtml(choiceLabel(choiceStat.key))}</div>
                    <div class="text-sm font-semibold text-slate-900">${choiceStat.count} người</div>
                </div>
                <div class="text-right">
                    <div class="inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-bold ${state.badgeClass}">${escapeHtml(state.label)}</div>
                    <div class="text-xs text-slate-500">Tỷ trọng</div>
                    <div class="text-sm font-black text-[#D3af37]">${pct.toFixed(1)}%</div>
                </div>
            </div>
            <div class="h-2 rounded-full bg-slate-100 overflow-hidden">
                <div class="h-full rounded-full ${choiceBarClass(choiceStat.key)}" style="width:${Math.max(4, pct)}%"></div>
            </div>
            <div class="text-xs text-slate-500">
                ${formatCoins(choiceStat.stake)} trong quỹ
            </div>
            <div class="space-y-2 max-h-56 overflow-y-auto pr-1">
                ${renderBettorList(list)}
            </div>
        </section>`;
}

function getChoiceState(choiceKey, settlement) {
    if (!settlement?.result_published) {
        return {
            label: "Chờ kết quả",
            badgeClass: "border-slate-200 bg-slate-50 text-slate-600",
        };
    }
    if (settlement.refunded) {
        return {
            label: "Hoàn điểm",
            badgeClass: "border-amber-200 bg-amber-50 text-amber-700",
        };
    }
    if (settlement.winning_choice === choiceKey) {
        return {
            label: "Cửa thắng",
            badgeClass: "border-emerald-200 bg-emerald-50 text-emerald-700",
        };
    }
    return {
        label: "Cửa thua",
        badgeClass: "border-rose-200 bg-rose-50 text-rose-700",
    };
}

function choiceBarClass(choice) {
    return {
        HOME: "bg-emerald-500",
        DRAW: "bg-sky-500",
        AWAY: "bg-pink-500",
    }[choice] || "bg-emerald-500";
}

function renderBettorList(list) {
    if (!list.length) {
        return `<div class="text-xs text-slate-500 italic">Chưa có ai vào cửa này.</div>`;
    }

    return list.map(bettor => {
        const title = escapeHtml(
            bettor.is_lone_wolf
                ? `${bettor.name} - cú đi ngược đám đông (${formatCoins(bettor.stake)})`
                : `${bettor.name} (${formatCoins(bettor.stake)})`
        );
        const wolfBadge = bettor.is_lone_wolf
            ? `<span class="ml-auto text-[10px] font-bold text-amber-600">khác biệt</span>`
            : "";
        const outcomeClass = getOutcomeBadgeClass(bettor.outcome);
        const rewardText = escapeHtml(bettor.reward_label || "");
        const quote = bettor.quote ? `<div class="mt-1 text-[11px] leading-snug italic text-slate-500">${escapeHtml(bettor.quote)}</div>` : "";
        return `
            <div class="flex items-start gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2" title="${title}">
                ${renderBettorAvatar(bettor)}
                <div class="min-w-0 flex-1">
                    <div class="flex items-center gap-2 min-w-0">
                <div class="text-sm font-semibold text-slate-900 truncate">${escapeHtml(bettor.name)}</div>
                <span class="inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-bold ${outcomeClass}">${escapeHtml(bettor.outcome_label || "Chờ kết quả")}</span>
            </div>
            <div class="text-[11px] text-slate-500">${formatVNDateTime(bettor.created_at)}</div>
            ${quote}
        </div>
        <div class="text-right shrink-0">
                    <div class="text-sm font-black text-[#D3af37]">${formatCoins(bettor.stake)}</div>
                    <div class="text-[11px] text-[#D3af37]">${rewardText}</div>
                </div>
                ${wolfBadge}
            </div>`;
    }).join("");
}

function getOutcomeBadgeClass(outcome) {
    return {
        WIN: "border-emerald-200 bg-emerald-50 text-emerald-700",
        LOSE: "border-rose-200 bg-rose-50 text-rose-700",
        REFUND: "border-amber-200 bg-amber-50 text-amber-700",
        PENDING: "border-slate-200 bg-slate-50 text-slate-600",
    }[outcome] || "border-slate-200 bg-slate-50 text-slate-600";
}

window.toggleGroup = function(dateKey) {
    const content = document.getElementById(`content-${dateKey}`);
    const icon = document.getElementById(`icon-${dateKey}`);
    content.classList.toggle("hidden");
    icon.classList.toggle("rotate-180");
};


// ─── 10. Live Ticker ──────────────────────────────────────────────────────────
async function startTicker() {
    const wrap = document.getElementById("ticker-content");
    if (!wrap) return;
    try {
        const res = await fetch("/api/v1/activity-feed", NO_CACHE_FETCH_OPTIONS);
        if (!res.ok) return;
        const activities = await res.json();
        if (!activities.length) return;

        const text = activities
            .map(a => `<span>${escapeHtml(a.text)}</span>`)
            .join(`<span class="ticker-sep">•</span>`);

        // Duplicate để loop mượt
        wrap.innerHTML = text + `<span class="ticker-sep">•••</span>` + text;

        // Reset animation
        wrap.style.animation = "none";
        wrap.offsetHeight; // reflow
        wrap.style.animation = "";
    } catch(e) {
        // Silently fail
    }
}


// ─── 11. Leaderboard (Bảng Phong Thần) ───────────────────────────────────────
async function fetchLeaderboard() {
    const el = document.getElementById("leaderboard-body");
    if (!el) return;
    try {
        const res = await fetch("/api/v1/leaderboard", NO_CACHE_FETCH_OPTIONS);
        if (!res.ok) return;
        const data = await res.json();
        renderLeaderboard(data, el);
    } catch(e) {
        // Silently fail
    }
}

function renderLeaderboard(data, container) {
    if (!data.length) {
        container.innerHTML = `<div class="text-center py-8 text-slate-500 text-sm">Chưa có dữ liệu xếp hạng.</div>`;
        return;
    }

    const BADGE_COLOR_MAP = {
        gold: "lb-badge-gold",
        purple: "lb-badge-purple",
        red: "lb-badge-red",
        gray: "lb-badge-gray",
    };

    const RANK_MEDALS = { 1: "🥇", 2: "🥈", 3: "🥉" };

    container.innerHTML = data.map(entry => {
        const rankEl = RANK_MEDALS[entry.rank]
            ? `<span class="lb-rank ${entry.rank === 1 ? "top1" : entry.rank === 2 ? "top2" : "top3"}">${RANK_MEDALS[entry.rank]}</span>`
            : `<span class="lb-rank">${entry.rank}</span>`;

        const badgeHtml = entry.badge
            ? `<span class="lb-badge ${BADGE_COLOR_MAP[entry.badge.color] || ""}">${escapeHtml(entry.badge.emoji)} ${escapeHtml(entry.badge.label)}</span>`
            : "";

        const rawName = String(entry.display_name ?? entry.name ?? "");
        const profileHref = entry.id ? `/profile?user_id=${encodeURIComponent(entry.id)}` : "/profile";

        let trendHtml;
        if (entry.trend === "up") {
            trendHtml = `<span class="lb-trend up"><span class="trend-arrow-up">↑</span> +${entry.earned_24h.toLocaleString()}</span>`;
        } else if (entry.trend === "down") {
            trendHtml = `<span class="lb-trend down">↓ Thua ${entry.streak_loss} trận</span>`;
        } else {
            trendHtml = `<span class="lb-trend neutral">— Ổn định</span>`;
        }

        return `
        <div class="lb-row">
            ${rankEl}
            <a href="${profileHref}" class="lb-info group text-left block">
                <div class="lb-name">
                    ${renderLeaderboardAvatar({ ...entry, name: rawName })}
                    <div class="min-w-0">
                        <span class="group-hover:underline">${escapeHtml(rawName)}</span>
                        ${badgeHtml}
                    </div>
                </div>
            </a>
            <div class="lb-points">
                <span class="lb-score">${entry.total_points.toLocaleString()}</span>
                ${trendHtml}
            </div>
        </div>`;
    }).join("");
}


// ─── 12. Toast Notification ───────────────────────────────────────────────────
function showToast(msg, type = "success") {
    const existing = document.getElementById("toast-container");
    if (existing) existing.remove();

    const color = type === "success" ? "bg-emerald-700 border-emerald-500" : "bg-red-800 border-red-600";
    const toast = document.createElement("div");
    toast.id = "toast-container";
    toast.className = `fixed bottom-6 left-1/2 -translate-x-1/2 z-50 px-4 py-3 rounded-xl border text-sm font-semibold text-white shadow-xl ${color} max-w-xs text-center`;
    toast.style.animation = "slideDown 0.25s ease";
    toast.textContent = msg;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 3500);
}

const matchSelections = {};

function getEffectiveMinStake(minStake) {
    const parsed = Number(minStake);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

function buildQuickStakeOptions(minStake, maxStake) {
    const effectiveMin = getEffectiveMinStake(minStake);
    const hasDynamicMin = Number.isFinite(Number(minStake)) && Number(minStake) > 0;
    const unique = new Set([...(hasDynamicMin ? [effectiveMin] : []), ...QUICK_STAKE_OPTIONS, maxStake]);
    return [...unique]
        .map(Number)
        .filter(value => Number.isFinite(value) && value >= effectiveMin && value <= maxStake)
        .sort((a, b) => a - b);
}

function normalizeStakeValue(rawVal, minStake, maxStake) {
    const effectiveMin = getEffectiveMinStake(minStake);
    const parsed = parseInt(rawVal, 10);
    if (!Number.isFinite(parsed)) return effectiveMin;
    return Math.max(effectiveMin, Math.min(parsed, maxStake));
}

function renderMatchCard(match) {
    const timeStr = new Date(match.start_time).toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" });
    const { id, home_team, home_icon, away_team, away_icon, handicap, stakes_home, stakes_draw, stakes_away, total_pool } = match;
    const status = String(match.status || "upcoming");
    const isLive = isLiveMatch(match);
    const canBet = status === "upcoming";
    const endTimeStr = match.end_time ? new Date(match.end_time).toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" }) : "-";
    const homeTeam = escapeHtml(home_team);
    const awayTeam = escapeHtml(away_team);
    const homeIconSrc = safeImageSrc(home_icon);
    const awayIconSrc = safeImageSrc(away_icon);
    const minStake = match.min_stake;
    const minStakeHint = minStake ? `Toi thieu ${formatCoins(minStake)}` : "Mở bát tự do";

    const hcSign = handicap > 0 ? "+" : "";
    const hcClass = handicap >= 0 ? "handicap-pos" : "handicap-neg";
    const hcBadge = handicap !== 0 ? `<span class="${hcClass}">(${hcSign}${handicap})</span>` : "";

    const betArea = placedBets.has(id)
        ? `<div class="bet-placed-badge">Da dat cuoc cho tran nay</div>`
        : canBet
        ? `
            <div class="bet-btn-group" id="btn-group-${id}">
                <div class="bet-choice-block">
                    <button class="bet-btn w-full" id="bet-home-${id}" onclick="selectChoice(${id}, 'HOME', ${total_pool}, ${stakes_home}, '${status}', ${minStake ?? "null"})">
                        <span class="bet-label">NHÀ</span>
                    </button>
                    <div class="avatar-stack-row" id="avatars-home-${id}"></div>
                </div>
                <div class="bet-choice-block">
                    <button class="bet-btn w-full" id="bet-draw-${id}" onclick="selectChoice(${id}, 'DRAW', ${total_pool}, ${stakes_draw}, '${status}', ${minStake ?? "null"})">
                        <span class="bet-label">HÒA</span>
                    </button>
                    <div class="avatar-stack-row" id="avatars-draw-${id}"></div>
                </div>
                <div class="bet-choice-block">
                    <button class="bet-btn w-full" id="bet-away-${id}" onclick="selectChoice(${id}, 'AWAY', ${total_pool}, ${stakes_away}, '${status}', ${minStake ?? "null"})">
                        <span class="bet-label">KHÁCH</span>
                    </button>
                    <div class="avatar-stack-row" id="avatars-away-${id}"></div>
                </div>
            </div>
            <div class="mt-2 text-center text-[11px] text-slate-500">${escapeHtml(minStakeHint)}</div>
            <div id="stake-panel-${id}" class="hidden"></div>`
        : `
            <div class="bet-btn-group" id="btn-group-${id}">
                <div class="bet-choice-block">
                    <div class="px-1 text-[11px] font-bold uppercase tracking-wide text-slate-500">NHÀ</div>
                    <div class="avatar-stack-row" id="avatars-home-${id}"></div>
                </div>
                <div class="bet-choice-block">
                    <div class="px-1 text-[11px] font-bold uppercase tracking-wide text-slate-500">HÒA</div>
                    <div class="avatar-stack-row" id="avatars-draw-${id}"></div>
                </div>
                <div class="bet-choice-block">
                    <div class="px-1 text-[11px] font-bold uppercase tracking-wide text-slate-500">KHÁCH</div>
                    <div class="avatar-stack-row" id="avatars-away-${id}"></div>
                </div>
            </div>
            <div class="mt-2 text-center text-[11px] text-slate-500">${escapeHtml(minStakeHint)}</div>
            <div id="stake-panel-${id}" class="hidden"></div>`;

    const homeIconHtml = homeIconSrc ? `<img src="${homeIconSrc}" class="w-6 h-6 inline-block mr-2 rounded-full border border-slate-200 bg-white">` : "";
    const awayIconHtml = awayIconSrc ? `<img src="${awayIconSrc}" class="w-6 h-6 inline-block ml-2 rounded-full border border-slate-200 bg-white">` : "";
    const liveBadge = isLive ? `
        <span class="inline-flex items-center gap-1 rounded-full border border-rose-200 bg-rose-50 px-2 py-1 text-[11px] font-bold text-rose-600">
            <span class="h-2 w-2 rounded-full bg-rose-500 animate-pulse"></span>
            LIVE
        </span>` : "";

    return `
        <div class="bg-white border border-slate-200 hover:border-sky-300 rounded-xl p-4 shadow-sm transition duration-200 mb-3 last:mb-0">
            <div class="flex items-center justify-between mb-2">
                <div class="flex items-center gap-2">
                    ${liveBadge}
                    <span class="text-xs bg-sky-50 text-sky-700 font-mono font-semibold px-2 py-1 rounded border border-sky-100">⏰ ${timeStr} - ${endTimeStr}</span>
                </div>
                <button type="button"
                    class="inline-flex items-center gap-1 text-xs bg-white text-slate-600 border border-slate-200 hover:border-sky-300 hover:text-sky-700 px-2.5 py-1 rounded-full transition-colors shadow-sm"
                    onclick="openMatchDetail(${id})"
                    title="Xem chi tiet tran">
                    <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
                        <path stroke-linecap="round" stroke-linejoin="round" d="M11 16h2M12 8v4m0 8a8 8 0 100-16 8 8 0 000 16z"/>
                    </svg>
                    <span>Chi tiết</span>
                </button>
            </div>

            <div class="flex items-center justify-between my-3 px-2">
                <div class="w-2/5 text-center flex flex-col items-center">
                    <div class="flex items-center justify-center mb-1">${homeIconHtml}</div>
                    <p class="text-sm font-bold text-slate-900 truncate w-full">${homeTeam} ${hcBadge}</p>
                    <span class="text-xs text-slate-500 block mt-0.5">Chủ nhà</span>
                </div>
                <div class="w-1/5 text-center text-slate-400 font-black text-sm">VS</div>
                <div class="w-2/5 text-center flex flex-col items-center">
                    <div class="flex items-center justify-center mb-1">${awayIconHtml}</div>
                    <p class="text-sm font-bold text-slate-900 truncate w-full">${awayTeam}</p>
                    <span class="text-xs text-slate-500 block mt-0.5">Khách</span>
                </div>
            </div>

            <div class="text-center text-xs text-slate-500 mb-1">
                Pool: <span class="text-[#D3af37] font-semibold">${formatCoins(total_pool)}</span>
            </div>

            ${betArea}
        </div>`;
}

window.selectChoice = function(matchId, choice, totalPool, stakesOnChoice, matchStatus = "upcoming", minStake = null) {
    if (String(matchStatus).toLowerCase() !== "upcoming") return;
    matchSelections[matchId] = { choice, totalPool, stakesOnChoice, status: matchStatus, minStake };

    ["HOME", "DRAW", "AWAY"].forEach(c => {
        const btn = document.getElementById(`bet-${c.toLowerCase()}-${matchId}`);
        if (btn) btn.classList.toggle("selected", c === choice);
    });

    renderStakePanel(matchId, choice, totalPool, stakesOnChoice, minStake);
};

function renderStakePanel(matchId, choice, totalPool, stakesOnChoice, minStake = null) {
    const panel = document.getElementById(`stake-panel-${matchId}`);
    const selection = matchSelections[matchId] || {};
    const matchStatus = selection.status || "upcoming";
    if (!panel || String(matchStatus).toLowerCase() !== "upcoming") return;

    const maxStake = currentUser ? Number(currentUser.total_points || 0) : 1000;
    const effectiveMin = getEffectiveMinStake(minStake ?? selection.minStake);
    const defaultStake = Math.max(effectiveMin, Math.min(buildQuickStakeOptions(minStake, maxStake)[0] || effectiveMin, maxStake));

    panel.classList.remove("hidden");
    if (maxStake < effectiveMin) {
        panel.innerHTML = `
            <div class="stake-panel">
                <label>So diem dat cuoc</label>
                <div class="text-sm text-rose-600 mt-2">Tran nay dang yeu cau toi thieu ${formatCoins(effectiveMin)}. Hien tai ban co ${formatCoins(maxStake)}.</div>
            </div>`;
        return;
    }

    const chips = buildQuickStakeOptions(minStake, maxStake).map(value => `
        <button type="button"
            class="rounded-full border border-slate-200 bg-white px-3 py-1.5 text-sm font-semibold text-slate-700 transition hover:border-sky-300 hover:text-sky-700"
            onclick="pickStake(${matchId}, ${totalPool}, ${stakesOnChoice}, ${value})">
            ${formatCoins(value)}
        </button>
    `).join("");

    panel.innerHTML = `
        <div class="stake-panel">
            <label>So diem dat cuoc</label>
            <div class="mt-2 text-xs text-slate-500">
                ${effectiveMin > 1 ? `Toi thieu hien tai: ${formatCoins(effectiveMin)}.` : "Chưa ai lên thuyền. Bạn có thể mở bát tự do."}
            </div>
            <div class="mt-3 flex flex-wrap gap-2">
                ${chips}
            </div>
            <div class="mt-3">
                <input type="number" class="stake-input w-full"
                    id="input-${matchId}"
                    min="${effectiveMin}" max="${maxStake}" step="1" value="${defaultStake}"
                    oninput="syncStake(${matchId}, ${totalPool}, ${stakesOnChoice}, this.value)">
            </div>
            <div class="est-return" id="est-${matchId}">
                Ước tính nhận: <strong>${formatCoins(estimateReward(totalPool, stakesOnChoice, defaultStake))}</strong>
            </div>
            <button class="confirm-bet-btn" id="confirm-btn-${matchId}" onclick="confirmBet(${matchId})">
                Xuống xác
            </button>
        </div>`;
}

window.pickStake = function(matchId, totalPool, stakesOnChoice, value) {
    syncStake(matchId, totalPool, stakesOnChoice, value);
};

window.syncStake = function(matchId, totalPool, stakesOnChoice, rawVal) {
    const input = document.getElementById(`input-${matchId}`);
    if (!input) return;
    const selection = matchSelections[matchId] || {};
    const maxStake = currentUser ? Number(currentUser.total_points || 0) : 9999;
    const value = normalizeStakeValue(rawVal, selection.minStake, maxStake);
    input.value = value;
    const est = estimateReward(totalPool, stakesOnChoice, value);
    const estEl = document.getElementById(`est-${matchId}`);
    if (estEl) estEl.innerHTML = `Ước tính nhận: <strong>${formatCoins(est)}</strong>`;
};

window.confirmBet = async function(matchId) {
    const sel = matchSelections[matchId];
    if (!sel || String(sel.status || "upcoming").toLowerCase() !== "upcoming") return;

    const input = document.getElementById(`input-${matchId}`);
    const effectiveMin = getEffectiveMinStake(sel.minStake);
    const stakeVal = parseInt(input?.value || "0", 10) || 0;
    if (stakeVal < effectiveMin) {
        showToast(`Số điểm tối thiểu là ${formatCoins(effectiveMin)}.`, "error");
        return;
    }
    if (currentUser && stakeVal > currentUser.total_points) {
        showToast("Số điểm không đủ.", "error");
        return;
    }

    const btn = document.getElementById(`confirm-btn-${matchId}`);
    btn.disabled = true;
    btn.textContent = "Đang xử...";

    try {
        const res = await fetch("/api/v1/bets", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ match_id: matchId, choice: sel.choice, stake: stakeVal }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            showToast(data.detail || "Đặt thất bại.", "error");
            btn.disabled = false;
            btn.textContent = "Xuống xác";
            return;
        }

        placedBets.add(matchId);
        updateDisplayedPoints(data.remaining_points);
        showToast(`Đóng họ thành công. Còn lại ${formatCoins(data.remaining_points)}.`, "success");
        matchDetailCache.delete(matchId);

        const stakePanel = document.getElementById(`stake-panel-${matchId}`);
        const btnGroup = document.getElementById(`btn-group-${matchId}`);
        if (stakePanel) stakePanel.innerHTML = "";
        if (btnGroup) btnGroup.outerHTML = `<div class="bet-placed-badge">Đã lên thuyền</div>`;

        fetchAvatarStack(matchId);
        fetchUpcomingMatches();
        startTicker();
    } catch (e) {
        showToast(" lỗi kết nối. Vui lòng thử lại.", "error");
        btn.disabled = false;
        btn.textContent = "Xuống xác";
    }
};
