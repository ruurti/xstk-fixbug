let matchCache = [];

document.addEventListener("DOMContentLoaded", () => {
    fetchMe();
    fetchMatches();
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
        return `<img src="${avatarSrc}" alt="" class="w-5 h-5 rounded-full object-cover border border-indigo-400/70 flex-shrink-0">`;
    }
    return `<span class="w-5 h-5 rounded-full border border-indigo-400/70 flex items-center justify-center text-[9px] font-black text-white flex-shrink-0" style="background:${safeCssColor(avatar_color)}">${escapeHtml(initials || "??")}</span>`;
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
                    <span class="font-semibold text-white truncate max-w-[10rem]">${escapeHtml(displayName)}</span>
                    <span class="text-indigo-300">| Admin</span>
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
            document.getElementById("admin-match-list").innerHTML = `<div class="p-4 bg-red-900/50 text-red-400 rounded-xl border border-red-800">Lỗi: ${escapeHtml(err.detail || "Không thể tải danh sách")}</div>`;
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
        list.innerHTML = '<div class="text-center text-gray-500 py-8">Không có trận đấu nào.</div>';
        return;
    }

    matches.forEach(m => {
        const isFinished = m.status === "finished";
        const card = document.createElement("div");
        card.className = "bg-gray-800 p-4 rounded-xl border border-gray-700 flex flex-col gap-4";
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
                        <span class="text-xs ${isFinished ? "text-gray-500 bg-gray-900 border-gray-700" : "text-emerald-400 bg-emerald-950 border-emerald-800"} px-2 py-0.5 rounded border">${status}</span>
                        <span class="text-xs text-gray-400 text-right">ID: ${m.id} | Kèo chấp: ${m.handicap} | ${escapeHtml(startTime)}</span>
                    </div>
                    <div class="flex justify-between items-center font-bold text-lg">
                        <div class="w-2/5 text-right flex items-center justify-end">${homeIconHtml}${homeTeam}</div>
                        <div class="w-1/5 text-center text-gray-500">${isFinished ? `${m.home_score} - ${m.away_score}` : "vs"}</div>
                        <div class="w-2/5 text-left flex items-center justify-start">${awayTeam}${awayIconHtml}</div>
                    </div>
                </div>
                <div class="flex gap-2 w-full md:w-auto justify-end">
                    <button onclick="editMatch(${m.id})" ${isFinished ? "disabled" : ""} class="px-3 py-2 rounded bg-gray-700 hover:bg-gray-600 text-white text-sm font-semibold disabled:opacity-40 disabled:cursor-not-allowed">Sửa</button>
                    <button onclick="deleteMatch(${m.id})" ${isFinished ? "disabled" : ""} class="px-3 py-2 rounded bg-red-700 hover:bg-red-600 text-white text-sm font-semibold disabled:opacity-40 disabled:cursor-not-allowed">Xóa</button>
                </div>
            </div>
        `;

        if (!isFinished) {
            html += `
            <div class="flex gap-2 w-full md:w-auto items-center justify-end">
                <input type="number" id="home-score-${m.id}" placeholder="H" class="w-16 bg-gray-900 border border-gray-700 text-white px-2 py-2 rounded text-center" min="0">
                <span class="text-gray-500">-</span>
                <input type="number" id="away-score-${m.id}" placeholder="A" class="w-16 bg-gray-900 border border-gray-700 text-white px-2 py-2 rounded text-center" min="0">
                <button onclick="resolveMatch(${m.id})" class="bg-indigo-600 hover:bg-indigo-500 text-white px-4 py-2 rounded font-semibold transition-colors whitespace-nowrap ml-2">Giải trận</button>
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
            ? "bg-emerald-950/50 border-emerald-800 text-emerald-200"
            : "bg-red-950/50 border-red-800 text-red-200"
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
