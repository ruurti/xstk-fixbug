let matchCache = [];
let rechargeCache = [];

document.addEventListener("DOMContentLoaded", () => {
    fetchMe();
    fetchMatches();
    fetchRechargeRequests();
    document.getElementById("match-form").addEventListener("submit", saveMatch);
    document.getElementById("csv-import-form").addEventListener("submit", importMatchesCsv);
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

function renderMiniAvatar({ avatar_url, avatar_color, initials }) {
    const avatarSrc = safeImageSrc(avatar_url);
    if (avatarSrc) {
        return `<img src="${avatarSrc}" alt="" class="w-5 h-5 rounded-full object-cover border border-sky-300 flex-shrink-0">`;
    }
    return `<span class="w-5 h-5 rounded-full border border-sky-300 flex items-center justify-center text-[9px] font-black text-white flex-shrink-0" style="background:${safeCssColor(avatar_color)}">${escapeHtml(initials || "??")}</span>`;
}

async function fetchRechargeRequests() {
    const list = document.getElementById("admin-recharge-list");
    if (!list) return;
    try {
        const res = await fetch("/api/v1/admin/recharge-requests");
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            list.innerHTML = `<div class="p-4 bg-rose-50 text-rose-700 rounded-xl border border-rose-200">Lỗi: ${escapeHtml(err.detail || "Không thể tải yêu cầu nạp điểm")}</div>`;
            return;
        }
        rechargeCache = await res.json();
        renderRechargeRequests(rechargeCache);
    } catch (err) {
        console.error(err);
        list.innerHTML = `<div class="p-4 bg-rose-50 text-rose-700 rounded-xl border border-rose-200">Đã xảy ra lỗi kết nối.</div>`;
    }
}

function renderRechargeRequests(requests) {
    const list = document.getElementById("admin-recharge-list");
    if (!list) return;
    if (!requests.length) {
        list.innerHTML = `<div class="text-center text-slate-500 py-6">Không có yêu cầu nạp điểm.</div>`;
        return;
    }

    list.innerHTML = requests.map(item => {
        const user = item.user || {};
        const isPending = item.status === "pending";
        const badge = isPending
            ? `<span class="text-xs px-2 py-0.5 rounded border bg-amber-50 text-amber-700 border-amber-200">Đang chờ</span>`
            : `<span class="text-xs px-2 py-0.5 rounded border bg-emerald-50 text-emerald-700 border-emerald-200">Đã xác nhận</span>`;
        const createdAt = new Date(item.created_at).toLocaleString("vi-VN", {
            hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit", year: "numeric"
        });
        const displayName = user.display_name || user.email || "User";
        const email = user.email || "";
        return `
            <div class="bg-white p-4 rounded-xl border border-slate-200 flex flex-col md:flex-row md:items-center justify-between gap-3 shadow-sm">
                <div class="min-w-0">
                    <div class="flex items-center gap-2 mb-1">
                        ${renderMiniAvatar(user)}
                        <span class="font-bold text-slate-900 truncate">${escapeHtml(displayName)}</span>
                        ${badge}
                    </div>
                    <div class="text-xs text-slate-500 truncate">${escapeHtml(email)} · #${item.id} · ${escapeHtml(createdAt)}</div>
                </div>
                <div class="flex items-center justify-between md:justify-end gap-3">
                    <div class="text-right">
                        <div class="text-lg font-black text-[#D3af37]">${Number(item.amount).toLocaleString()} điểm</div>
                        <div class="text-xs text-slate-500">Số dư: ${Number(user.total_points || 0).toLocaleString()}</div>
                    </div>
                    <button onclick="approveRechargeRequest(${item.id})" ${isPending ? "" : "disabled"}
                        class="px-3 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-semibold disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
                        Xác nhận
                    </button>
                </div>
            </div>`;
    }).join("");
}

async function approveRechargeRequest(id) {
    const request = rechargeCache.find(item => item.id === id);
    if (!request || request.status !== "pending") return;
    if (!confirm(`Xác nhận cộng ${Number(request.amount).toLocaleString()} điểm cho ${request.user?.email || "user"}?`)) return;

    try {
        const res = await fetch(`/api/v1/admin/recharge-requests/${id}/approve`, { method: "POST" });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            alert(`Lỗi: ${data.detail || "Không thể xác nhận yêu cầu"}`);
            return;
        }
        await fetchRechargeRequests();
    } catch (err) {
        console.error(err);
        alert("Đã xảy ra lỗi hệ thống.");
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

async function fetchMe() {
    try {
        const res = await fetch("/api/v1/me");
        if (res.ok) {
            const data = await res.json();
            const shortEmail = data.email.split("@")[0];
            const displayName = data.display_name || shortEmail;
            const el = document.getElementById("user-info");
            el.title = data.email;
            el.innerHTML = `
                <span class="inline-flex items-center gap-2">
                    ${renderMiniAvatar(data)}
                    <span class="font-semibold text-slate-900 truncate max-w-[10rem]">${escapeHtml(displayName)}</span>
                    <span class="text-sky-600">| Admin</span>
                </span>`;
        } else {
            document.getElementById("user-info").innerText = "Lỗi xác thực";
        }
    } catch (err) {
        console.error(err);
    }
}

async function fetchMatches() {
    try {
        const res = await fetch("/api/v1/admin/matches");
        if (!res.ok) {
            const err = await res.json();
            document.getElementById("admin-match-list").innerHTML = `<div class="p-4 bg-rose-50 text-rose-700 rounded-xl border border-rose-200">Lỗi: ${escapeHtml(err.detail || "Không thể tải danh sách")}</div>`;
            return;
        }
        matchCache = await res.json();
        renderMatches(matchCache);
    } catch (err) {
        console.error(err);
    }
}

function renderMatches(matches) {
    const list = document.getElementById("admin-match-list");
    list.innerHTML = "";

    if (matches.length === 0) {
        list.innerHTML = '<div class="text-center text-slate-500 py-8">Không có trận đấu nào.</div>';
        return;
    }

    matches.forEach(m => {
        const isFinished = m.status === "finished";
        const card = document.createElement("div");
        card.className = "bg-white p-4 rounded-xl border border-slate-200 flex flex-col gap-4 shadow-sm";
        const homeIconSrc = safeImageSrc(m.home_icon);
        const awayIconSrc = safeImageSrc(m.away_icon);
        const homeIconHtml = homeIconSrc ? `<img src="${homeIconSrc}" class="w-5 h-5 inline-block mr-1 rounded-full" alt="">` : "";
        const awayIconHtml = awayIconSrc ? `<img src="${awayIconSrc}" class="w-5 h-5 inline-block ml-1 rounded-full" alt="">` : "";
        const homeTeam = escapeHtml(m.home_team);
        const awayTeam = escapeHtml(m.away_team);
        const status = escapeHtml(m.status);
        const startTime = new Date(m.start_time).toLocaleString("vi-VN", { hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit", year: "numeric" });

        let html = `
            <div class="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
                <div class="flex-1 w-full">
                    <div class="flex items-center justify-between mb-2 gap-3">
                        <span class="text-xs ${isFinished ? "text-slate-600 bg-slate-50 border-slate-200" : "text-emerald-700 bg-emerald-50 border-emerald-200"} px-2 py-0.5 rounded border">${status}</span>
                        <span class="text-xs text-slate-500 text-right">ID: ${m.id} | Kèo chấp: ${m.handicap} | ${escapeHtml(startTime)}</span>
                    </div>
                    <div class="flex justify-between items-center font-bold text-lg text-slate-900">
                        <div class="w-2/5 text-right flex items-center justify-end">${homeIconHtml}${homeTeam}</div>
                        <div class="w-1/5 text-center text-slate-400">${isFinished ? `${m.home_score} - ${m.away_score}` : "vs"}</div>
                        <div class="w-2/5 text-left flex items-center justify-start">${awayTeam}${awayIconHtml}</div>
                    </div>
                </div>
                <div class="flex gap-2 w-full md:w-auto justify-end">
                    <button onclick="editMatch(${m.id})" ${isFinished ? "disabled" : ""} class="px-3 py-2 rounded border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 text-sm font-semibold disabled:opacity-40 disabled:cursor-not-allowed">Sửa</button>
                    <button onclick="deleteMatch(${m.id})" ${isFinished ? "disabled" : ""} class="px-3 py-2 rounded border border-rose-200 bg-rose-50 hover:bg-rose-100 text-rose-700 text-sm font-semibold disabled:opacity-40 disabled:cursor-not-allowed">Xóa</button>
                </div>
            </div>
        `;

        if (!isFinished) {
            html += `
            <div class="flex gap-2 w-full md:w-auto items-center justify-end">
                <input type="number" id="home-score-${m.id}" placeholder="H" class="w-16 bg-white border border-slate-200 text-slate-900 px-2 py-2 rounded text-center" min="0">
                <span class="text-slate-400">-</span>
                <input type="number" id="away-score-${m.id}" placeholder="A" class="w-16 bg-white border border-slate-200 text-slate-900 px-2 py-2 rounded text-center" min="0">
                <button onclick="resolveMatch(${m.id})" class="bg-sky-600 hover:bg-sky-500 text-white px-4 py-2 rounded font-semibold transition-colors whitespace-nowrap ml-2">Giải trận</button>
            </div>
            `;
        }

        card.innerHTML = html;
        list.appendChild(card);
    });
}

async function saveMatch(event) {
    event.preventDefault();
    const id = document.getElementById("match-id").value;
    const btn = document.getElementById("save-match-btn");
    const payload = getMatchPayload();
    if (!payload.home_team || !payload.away_team || !payload.start_time) {
        alert("Vui lòng nhập đầy đủ đội nhà, đội khách và thời gian.");
        return;
    }

    btn.disabled = true;
    const oldText = btn.innerText;
    btn.innerText = "Đang lưu...";

    try {
        const url = id ? `/api/v1/admin/matches/${id}/update` : "/api/v1/admin/matches";
        const res = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
        });
        const data = await res.json();
        if (res.ok) {
            resetMatchForm();
            await fetchMatches();
        } else {
            alert(`Lỗi: ${data.detail}`);
        }
    } catch (err) {
        console.error(err);
        alert("Đã xảy ra lỗi hệ thống.");
    } finally {
        btn.disabled = false;
        btn.innerText = oldText;
    }
}

function showCsvImportResult(message, type = "success", errors = []) {
    const el = document.getElementById("csv-import-result");
    const errorHtml = errors.length
        ? `<ul class="mt-2 list-disc list-inside text-xs">${errors.map(err => `<li>Dòng ${escapeHtml(err.line)}: ${escapeHtml(err.error)}</li>`).join("")}</ul>`
        : "";
    el.className = `mt-3 text-sm rounded-lg border px-3 py-2 ${
        type === "success"
            ? "bg-emerald-50 border-emerald-200 text-emerald-700"
            : "bg-rose-50 border-rose-200 text-rose-700"
    }`;
    el.innerHTML = `${escapeHtml(message)}${errorHtml}`;
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
    const oldText = btn.innerText;
    btn.innerText = "Đang import...";

    try {
        const res = await fetch("/api/v1/admin/matches/import-csv", {
            method: "POST",
            body: formData,
        });
        const data = await res.json();
        if (res.ok && !data.errors?.length) {
            showCsvImportResult(`${data.message} Tạo mới: ${data.created}, cập nhật: ${data.updated}.`, "success");
            fileInput.value = "";
            resetMatchForm();
            await fetchMatches();
        } else {
            showCsvImportResult(data.message || data.detail || "Import CSV thất bại.", "error", data.errors || []);
        }
    } catch (err) {
        console.error(err);
        showCsvImportResult("Đã xảy ra lỗi hệ thống khi import CSV.", "error");
    } finally {
        btn.disabled = false;
        btn.innerText = oldText;
    }
}

function editMatch(id) {
    const match = matchCache.find(m => m.id === id);
    if (!match || match.status === "finished") return;

    document.getElementById("match-id").value = match.id;
    document.getElementById("home-team").value = match.home_team;
    document.getElementById("away-team").value = match.away_team;
    document.getElementById("home-icon").value = match.home_icon || "";
    document.getElementById("away-icon").value = match.away_icon || "";
    document.getElementById("handicap").value = match.handicap;
    document.getElementById("status").value = match.status === "live" ? "live" : "upcoming";
    document.getElementById("start-time").value = toDatetimeLocal(match.start_time);
    document.getElementById("match-form-title").innerText = `Sửa trận #${match.id}`;
    document.getElementById("save-match-btn").innerText = "Cập nhật";
    document.getElementById("cancel-edit-btn").classList.remove("hidden");
    document.getElementById("home-team").focus();
}

function resetMatchForm() {
    document.getElementById("match-form").reset();
    document.getElementById("match-id").value = "";
    document.getElementById("handicap").value = "0";
    document.getElementById("status").value = "upcoming";
    document.getElementById("match-form-title").innerText = "Thêm trận đấu";
    document.getElementById("save-match-btn").innerText = "Lưu trận";
    document.getElementById("cancel-edit-btn").classList.add("hidden");
}

async function deleteMatch(id) {
    const match = matchCache.find(m => m.id === id);
    if (!match || match.status === "finished") return;
    if (!confirm(`Xóa trận ${match.home_team} vs ${match.away_team}?`)) return;

    try {
        const res = await fetch(`/api/v1/admin/matches/${id}/delete`, { method: "POST" });
        const data = await res.json();
        if (res.ok) {
            if (document.getElementById("match-id").value === String(id)) resetMatchForm();
            await fetchMatches();
        } else {
            alert(`Lỗi: ${data.detail}`);
        }
    } catch (err) {
        console.error(err);
        alert("Đã xảy ra lỗi hệ thống.");
    }
}

async function resolveMatch(id) {
    const homeScoreInput = document.getElementById(`home-score-${id}`);
    const awayScoreInput = document.getElementById(`away-score-${id}`);

    if (!homeScoreInput || !awayScoreInput || homeScoreInput.value === "" || awayScoreInput.value === "") {
        alert("Vui lòng nhập tỉ số cho cả hai đội!");
        return;
    }

    const home_score = parseInt(homeScoreInput.value);
    const away_score = parseInt(awayScoreInput.value);

    if (confirm(`Bạn có chắc muốn giải trận đấu này với tỉ số: ${home_score} - ${away_score}?`)) {
        try {
            const res = await fetch(`/api/v1/admin/resolve-match/${id}`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ home_score, away_score }),
            });
            const data = await res.json();
            if (res.ok) {
                alert(`Thành công! Kết quả kèo: ${data.winning_choice}`);
                fetchMatches();
            } else {
                alert(`Lỗi: ${data.detail}`);
            }
        } catch (err) {
            console.error(err);
            alert("Đã xảy ra lỗi hệ thống.");
        }
    }
}
