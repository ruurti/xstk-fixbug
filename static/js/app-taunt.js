(function () {
    if (typeof window === "undefined") return;

    const tauntRotators = new Map();
    const baseFetchUpcomingMatches = fetchUpcomingMatches;

    // Trả về mô tả handicap: dùng từ tiếng Việt thuần cho 0.25/0.5/0.75, còn lại dùng số
    function formatHandicapText(homeName, awayName, handicap) {
        if (!handicap || handicap === 0) return "";
        const absHc = Math.abs(handicap);
        const whole = Math.floor(absHc);
        const fraction = Math.round((absHc - whole) * 100);

        let hcStr;
        if (fraction === 0) {
            hcStr = `${whole} trái`;
        } else if (whole === 0 && fraction === 25) {
            hcStr = "1/4 trái";
        } else if (whole === 0 && fraction === 50) {
            hcStr = "nửa trái";
        } else if (whole === 0 && fraction === 75) {
            hcStr = "3/4 trái";
        } else {
            // Số lẻ phức tạp: dùng số thuần để tránh từ ghép ngô nghê
            hcStr = `${absHc} trái`;
        }

        return handicap < 0
            ? `<strong>${homeName}</strong> chấp <strong>${awayName}</strong> ${hcStr}`
            : `<strong>${awayName}</strong> chấp <strong>${homeName}</strong> ${hcStr}`;
    }

    window.formatCoins = function formatCoinsClean(value) {
        return `${Number(value || 0).toLocaleString()}d`;
    };

    window.choiceLabel = function choiceLabelClean(choice) {
        return { HOME: "Chủ nhà", DRAW: "Hòa", AWAY: "Khách" }[choice] || choice;
    };

    function tauntRotatorKey(matchId, choice) {
        return `${matchId}:${choice}`;
    }

    function clearTauntRotator(matchId, choice) {
        const key = tauntRotatorKey(matchId, choice);
        const timer = tauntRotators.get(key);
        if (timer) {
            window.clearInterval(timer);
            tauntRotators.delete(key);
        }
    }

    function clearAllTauntRotators() {
        tauntRotators.forEach(timer => window.clearInterval(timer));
        tauntRotators.clear();
    }

    function renderTauntBubble(slot, entry) {
        if (!slot || !entry) return;
        const displayName = escapeHtml(entry.display_name || entry.name || entry.initials || "User");
        const tauntText = escapeHtml(entry.taunt_text || "");

        // Avatar mini: ảnh hoặc initials với màu
        const avatarSrc = safeImageSrc(entry.avatar_url);
        const avatarBg = safeCssColor(entry.avatar_color);
        const initials = escapeHtml(entry.initials || displayName.slice(0, 2).toUpperCase() || "?");
        const avatarHtml = avatarSrc
            ? `<img src="${avatarSrc}" alt="" class="taunt-avatar-mini" style="object-fit:cover;">`
            : `<span class="taunt-avatar-mini" style="background:${avatarBg}">${initials}</span>`;

        slot.innerHTML = `
            <div class="taunt-chat-row">
                ${avatarHtml}
                <div class="taunt-bubble">
                    <div class="taunt-name">${displayName}</div>
                    <div class="taunt-text">${tauntText}</div>
                </div>
            </div>
        `;
    }

    function renderTauntSlot(container, bettors) {
        const slotId = container?.id?.replace("avatars-", "taunt-");
        const slot = slotId ? document.getElementById(slotId) : null;
        if (!slot || !container?.id) return;

        const parts = container.id.split("-");
        const choice = (parts[1] || "").toUpperCase();
        const matchId = parts[2];
        clearTauntRotator(matchId, choice);

        const taunts = bettors.filter(entry => String(entry.taunt_text || "").trim());
        if (!taunts.length) {
            slot.innerHTML = "";
            slot.classList.remove("has-taunt");
            return;
        }

        slot.classList.add("has-taunt");
        let index = 0;
        renderTauntBubble(slot, taunts[index]);

        if (taunts.length === 1) return;

        const timer = window.setInterval(() => {
            index = (index + 1) % taunts.length;
            renderTauntBubble(slot, taunts[index]);
        }, 3000);
        tauntRotators.set(tauntRotatorKey(matchId, choice), timer);
    }

    function renderPoolBlock(totalPool, stakesHome, stakesDraw, stakesAway, isOddHandicap) {
        const pool = Number(totalPool) || 0;
        const home = Number(stakesHome) || 0;
        const draw = Number(stakesDraw) || 0;
        const away = Number(stakesAway) || 0;

        if (pool === 0) {
            return `
                <div class="pool-block pool-block-empty">
                    <span class="pool-empty-icon">🏦</span>
                    <span class="pool-empty-text">Chưa có ai góp quỹ — vào trước để mở pool!</span>
                </div>`;
        }

        const homePct = Math.round((home / pool) * 100);
        const drawPct = isOddHandicap ? 0 : Math.round((draw / pool) * 100);
        const awayPct = 100 - homePct - drawPct;

        const barHome  = homePct > 0 ? `<div class="pool-bar-seg pool-bar-home"  style="width:${homePct}%"  title="Nhà ${homePct}%"></div>` : "";
        const barDraw  = (!isOddHandicap && drawPct > 0) ? `<div class="pool-bar-seg pool-bar-draw"  style="width:${drawPct}%"  title="Hòa ${drawPct}%"></div>` : "";
        const barAway  = awayPct > 0 ? `<div class="pool-bar-seg pool-bar-away"  style="width:${awayPct}%" title="Khách ${awayPct}%"></div>` : "";

        const breakdownHome = `
            <div class="pool-side pool-side-home">
                <span class="pool-side-label">NHÀ</span>
                <span class="pool-side-pct">${homePct}%</span>
                <span class="pool-side-amt">${formatCoins(home)}</span>
            </div>`;
        const breakdownDraw = !isOddHandicap ? `
            <div class="pool-side pool-side-draw">
                <span class="pool-side-label">HÒA</span>
                <span class="pool-side-pct">${drawPct}%</span>
                <span class="pool-side-amt">${formatCoins(draw)}</span>
            </div>` : "";
        const breakdownAway = `
            <div class="pool-side pool-side-away">
                <span class="pool-side-label">KHÁCH</span>
                <span class="pool-side-pct">${awayPct}%</span>
                <span class="pool-side-amt">${formatCoins(away)}</span>
            </div>`;

        return `
            <div class="pool-block">
                <div class="pool-total-row">
                    <span class="pool-total-icon">💰</span>
                    <span class="pool-total-amount">${formatCoins(pool)}</span>
                    <span class="pool-total-label">tổng quỹ</span>
                </div>
                <div class="pool-bar">${barHome}${barDraw}${barAway}</div>
                <div class="pool-breakdown${isOddHandicap ? " pool-breakdown-2col" : ""}">
                    ${breakdownHome}${breakdownDraw}${breakdownAway}
                </div>
            </div>`;
    }

    function renderChoiceBlock(matchId, totalPool, status, minStake, choice, label, stakeValue, clickable) {
        const choiceId = choice.toLowerCase();
        const tauntSlot = `<div class="taunt-slot" id="taunt-${choiceId}-${matchId}"></div>`;
        const avatars = `<div class="avatar-stack-row" id="avatars-${choiceId}-${matchId}"></div>`;

        if (clickable) {
            return `
                <div class="bet-choice-block">
                    ${tauntSlot}
                    <button class="bet-btn w-full" id="bet-${choiceId}-${matchId}" onclick="selectChoice(${matchId}, '${choice}', ${totalPool}, ${stakeValue}, '${status}', ${minStake ?? "null"})">
                        <span class="bet-label">${label}</span>
                    </button>
                    ${avatars}
                </div>
            `;
        }

        return `
            <div class="bet-choice-block">
                ${tauntSlot}
                <div class="bet-choice-caption">${label}</div>
                ${avatars}
            </div>
        `;
    }

    window.fetchUpcomingMatches = async function fetchUpcomingMatchesWithTaunt() {
        clearAllTauntRotators();
        return baseFetchUpcomingMatches();
    };

    window.fetchAvatarStack = async function fetchAvatarStackWithTaunt(matchId) {
        try {
            const res = await fetch(`/api/v1/matches/${matchId}/bets`, NO_CACHE_FETCH_OPTIONS);
            if (!res.ok) return;
            const data = await res.json();
            ["HOME", "DRAW", "AWAY"].forEach(choice => {
                const slot = document.getElementById(`avatars-${choice.toLowerCase()}-${matchId}`);
                if (!slot) return;
                renderAvatarStack(slot, data[choice] || []);
            });
        } catch (error) {
            // Non-critical UI.
        }
    };

    window.renderAvatarStack = function renderAvatarStackWithTaunt(container, bettors) {
        renderTauntSlot(container, bettors);

        if (!bettors.length) {
            container.innerHTML = `<span class="text-gray-400 text-xs">-</span>`;
            return;
        }

        const MAX_SHOW = 5;
        const shown = bettors.slice(0, MAX_SHOW);
        const extra = bettors.length - MAX_SHOW;

        let avatarsHtml = shown.map(b => {
            const rawName = String(b.name ?? "");
            const lwClass = b.is_lone_wolf ? " lone-wolf" : "";
            const lwIcon = b.is_lone_wolf ? `<span style="position:absolute;top:-7px;right:-3px;font-size:0.6rem;line-height:1">!</span>` : "";
            const title = escapeHtml(
                b.is_lone_wolf
                    ? `${rawName} - Lone wolf (${formatCoins(b.stake)})`
                    : `${rawName} (${formatCoins(b.stake)})`
            );
            const avatar = renderBettorAvatar(b, "w-full h-full");
            return `<div class="avatar-circle${lwClass}" title="${title}">${lwIcon}${avatar}</div>`;
        }).join("");

        if (extra > 0) {
            avatarsHtml += `<div class="avatar-more">+${extra}</div>`;
        }

        container.innerHTML = `<div class="avatar-stack">${avatarsHtml}</div>`;
    };

    window.renderMatchCard = function renderMatchCardWithTaunt(match) {
        const timeStr = new Date(match.start_time).toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" });
        const { id, home_team, home_icon, away_team, away_icon, handicap, stakes_home, stakes_draw, stakes_away, total_pool } = match;
        const status = String(match.status || "upcoming");
        const isLive = isLiveMatch(match);
        const hasPlaced = placedBets.has(id);
        const canBet = status === "upcoming" && !hasPlaced;
        const endTimeStr = match.end_time ? new Date(match.end_time).toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" }) : "-";
        const homeTeam = escapeHtml(home_team);
        const awayTeam = escapeHtml(away_team);
        const homeIconSrc = safeImageSrc(home_icon);
        const awayIconSrc = safeImageSrc(away_icon);
        const minStake = match.min_stake;
        const minStakeHint = minStake ? `Tối thiểu ${formatCoins(minStake)}` : "Người đầu mở pool tự do";
        // Kèo chấp lẻ (0.5, 1.5, ...) không có kết quả hòa
        const isOddHandicap = handicap % 1 !== 0;

        const hcSign = handicap > 0 ? "+" : "";
        const hcClass = handicap >= 0 ? "handicap-pos" : "handicap-neg";
        const hcBadge = handicap !== 0 ? `<span class="${hcClass}">(${hcSign}${handicap})</span>` : "";

        const choiceGrid = `
            <div class="bet-btn-group" id="btn-group-${id}">
                ${renderChoiceBlock(id, total_pool, status, minStake, "HOME", "Nhà", stakes_home, canBet)}
                ${!isOddHandicap ? renderChoiceBlock(id, total_pool, status, minStake, "DRAW", "Hòa", stakes_draw, canBet) : ""}
                ${renderChoiceBlock(id, total_pool, status, minStake, "AWAY", "Khách", stakes_away, canBet)}
            </div>
        `;

        const betArea = canBet
            ? `
                ${choiceGrid}
                <div class="mt-2 text-center text-[11px] text-slate-500">${escapeHtml(minStakeHint)}</div>
                <div id="stake-panel-${id}" class="hidden"></div>
            `
            : `
                ${hasPlaced ? `<div class="bet-placed-badge">Đã đặt cược cho trận này</div>` : ""}
                ${choiceGrid}
                <div id="stake-panel-${id}" class="hidden"></div>
            `;

        const homeIconHtml = homeIconSrc ? `<img src="${homeIconSrc}" class="w-6 h-6 inline-block mr-2 rounded-full border border-slate-200 bg-white">` : "";
        const awayIconHtml = awayIconSrc ? `<img src="${awayIconSrc}" class="w-6 h-6 inline-block ml-2 rounded-full border border-slate-200 bg-white">` : "";
        const liveBadge = isLive ? `
            <span class="inline-flex items-center gap-1 rounded-full border border-rose-200 bg-rose-50 px-2 py-1 text-[11px] font-bold text-rose-600">
                <span class="live-dot"></span>
                LIVE
            </span>` : "";

        const handicapText = formatHandicapText(home_team, away_team, handicap);

        return `
            <div class="bg-white border border-slate-200 hover:border-sky-300 rounded-2xl p-3 sm:p-4 shadow-sm transition duration-200 mb-3 last:mb-0">
                <div class="flex items-center justify-between mb-2">
                    <div class="flex items-center gap-2 flex-wrap">
                        ${liveBadge}
                        <span class="match-time-block">⏰ ${timeStr} <span class="match-time-sep">→</span> ${endTimeStr}</span>
                    </div>
                    <button type="button"
                        class="inline-flex items-center gap-1 text-xs bg-white text-slate-600 border border-slate-200 hover:border-sky-300 hover:text-sky-700 px-2.5 py-1 rounded-full transition-colors shadow-sm"
                        onclick="openMatchDetail(${id})"
                        title="Xem chi tiết trận">
                        <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
                            <path stroke-linecap="round" stroke-linejoin="round" d="M11 16h2M12 8v4m0 8a8 8 0 100-16 8 8 0 000 16z"/>
                        </svg>
                        <span>Chi tiết</span>
                    </button>
                </div>

                <div class="flex items-center justify-between my-3 px-2">
                    <div class="w-2/5 text-center flex flex-col items-center">
                        <div class="flex items-center justify-center mb-1">${homeIconHtml}</div>
                        <p class="text-sm font-bold text-slate-900 truncate w-full">${homeTeam}</p>
                        <span class="text-xs text-slate-500 block mt-0.5">Chủ nhà</span>
                    </div>
                    <div class="w-1/5 text-center text-slate-400 font-black text-sm">VS</div>
                    <div class="w-2/5 text-center flex flex-col items-center">
                        <div class="flex items-center justify-center mb-1">${awayIconHtml}</div>
                        <p class="text-sm font-bold text-slate-900 truncate w-full">${awayTeam}</p>
                        <span class="text-xs text-slate-500 block mt-0.5">Khách</span>
                    </div>
                </div>

                ${handicapText ? `<div class="match-handicap-info">⚖️ ${handicapText}</div>` : ""}

                ${renderPoolBlock(total_pool, stakes_home, stakes_draw, stakes_away, isOddHandicap)}

                ${betArea}
            </div>
        `;
    };

    window.selectChoice = function selectChoiceWithTaunt(matchId, choice, totalPool, stakesOnChoice, matchStatus = "upcoming", minStake = null) {
        if (String(matchStatus).toLowerCase() !== "upcoming") return;
        matchSelections[matchId] = { choice, totalPool, stakesOnChoice, status: matchStatus, minStake };

        ["HOME", "DRAW", "AWAY"].forEach(currentChoice => {
            const btn = document.getElementById(`bet-${currentChoice.toLowerCase()}-${matchId}`);
            if (btn) btn.classList.toggle("selected", currentChoice === choice);
        });

        renderStakePanel(matchId, choice, totalPool, stakesOnChoice, minStake);
    };

    window.pickStake = function pickStakeWithTaunt(matchId, totalPool, stakesOnChoice, value) {
        syncStake(matchId, totalPool, stakesOnChoice, value);
    };

    window.syncStake = function syncStakeWithTaunt(matchId, totalPool, stakesOnChoice, rawVal) {
        const input = document.getElementById(`input-${matchId}`);
        if (!input) return;
        const selection = matchSelections[matchId] || {};
        const maxStake = currentUser ? Number(currentUser.total_points || 0) : 9999;
        const value = normalizeStakeValue(rawVal, selection.minStake, maxStake);
        input.value = value;

        const estEl = document.getElementById(`est-${matchId}`);
        if (estEl) {
            estEl.innerHTML = `Ước tính nhận: <strong>${formatCoins(estimateReward(totalPool, stakesOnChoice, value))}</strong>`;
        }
    };

    window.updateBetTauntCounter = function updateBetTauntCounter(matchId) {
        const input = document.getElementById(`taunt-${matchId}`);
        const counter = document.getElementById(`taunt-count-${matchId}`);
        if (!input || !counter) return;
        counter.textContent = `${input.value.length}/30`;
        counter.classList.toggle("text-rose-500", input.value.length > 27);
        counter.classList.toggle("text-slate-400", input.value.length <= 27);
    };

    window.renderStakePanel = function renderStakePanelWithTaunt(matchId, choice, totalPool, stakesOnChoice, minStake = null) {
        const panel = document.getElementById(`stake-panel-${matchId}`);
        const selection = matchSelections[matchId] || {};
        const matchStatus = selection.status || "upcoming";
        if (!panel || String(matchStatus).toLowerCase() !== "upcoming") return;

        const maxStake = currentUser ? Number(currentUser.total_points || 0) : 1000;
        const effectiveMin = getEffectiveMinStake(minStake ?? selection.minStake);
        const defaultTaunt = String(currentUser?.default_taunt || "");

        panel.classList.remove("hidden");
        if (maxStake < effectiveMin) {
            panel.innerHTML = `
                <div class="stake-panel">
                    <label>Số điểm đặt cược</label>
                    <div class="text-sm text-rose-600 mt-2">Trận này yêu cầu tối thiểu ${formatCoins(effectiveMin)}. Hiện bạn có ${formatCoins(maxStake)}.</div>
                </div>`;
            return;
        }

        const tauntBlock = `
            <div class="mt-3">
                <label>Câu gáy cho trận này</label>
                <textarea
                    id="taunt-${matchId}"
                    class="stake-taunt-input mt-2"
                    rows="2"
                    maxlength="30"
                    placeholder="Thêm 1 câu gáy ngắn gọn..."
                    oninput="updateBetTauntCounter(${matchId})"
                >${escapeHtml(defaultTaunt)}</textarea>
                <div class="mt-1 flex items-center justify-end text-xs text-slate-400">
                    <span id="taunt-count-${matchId}">${defaultTaunt.length}/30</span>
                </div>
            </div>`;

        // Khi đã có người đặt: số tiền cố định, không cho chọn lại
        const isFixedStake = minStake !== null && minStake !== undefined;
        if (isFixedStake) {
            const fixedStake = effectiveMin;
            panel.innerHTML = `
                <div class="stake-panel">
                    <div class="fixed-stake-display">
                        <div class="fixed-stake-label">Số điểm đặt cược (cố định cho trận này)</div>
                        <div class="fixed-stake-amount">${formatCoins(fixedStake)}</div>
                        <div class="text-[11px] text-amber-700 mt-1">Mọi người cùng đặt 1 mức để công bằng</div>
                    </div>
                    <input type="hidden" id="input-${matchId}" value="${fixedStake}">
                    ${tauntBlock}
                    <div class="est-return" id="est-${matchId}">
                        Ước tính nhận: <strong>${formatCoins(estimateReward(totalPool, stakesOnChoice, fixedStake))}</strong>
                    </div>
                    <button class="confirm-bet-btn" id="confirm-btn-${matchId}" onclick="confirmBet(${matchId})">
                        Xác nhận đặt cược
                    </button>
                </div>
            `;
            window.updateBetTauntCounter(matchId);
            return;
        }

        // Người đầu tiên: tự do chọn số tiền
        const quickOptions = buildQuickStakeOptions(minStake, maxStake);
        const defaultStake = Math.max(effectiveMin, Math.min(quickOptions[0] || effectiveMin, maxStake));
        const chips = quickOptions.map(value => `
            <button type="button" class="stake-chip" onclick="pickStake(${matchId}, ${totalPool}, ${stakesOnChoice}, ${value})">
                ${formatCoins(value)}
            </button>
        `).join("");

        panel.innerHTML = `
            <div class="stake-panel">
                <label>Số điểm đặt cược</label>
                <div class="mt-2 text-xs text-slate-500">Bạn là người đầu tiên — số tiền bạn đặt sẽ là mức chung cho trận này.</div>
                <div class="mt-3 flex flex-wrap gap-2">
                    ${chips}
                </div>
                <div class="mt-3">
                    <input type="number" class="stake-input w-full"
                        id="input-${matchId}"
                        min="${effectiveMin}" max="${maxStake}" step="1" value="${defaultStake}"
                        oninput="syncStake(${matchId}, ${totalPool}, ${stakesOnChoice}, this.value)">
                </div>
                ${tauntBlock}
                <div class="est-return" id="est-${matchId}">
                    Ước tính nhận: <strong>${formatCoins(estimateReward(totalPool, stakesOnChoice, defaultStake))}</strong>
                </div>
                <button class="confirm-bet-btn" id="confirm-btn-${matchId}" onclick="confirmBet(${matchId})">
                    Xác nhận đặt cược
                </button>
            </div>
        `;

        window.updateBetTauntCounter(matchId);
    };

    window.confirmBet = async function confirmBetWithTaunt(matchId) {
        const selection = matchSelections[matchId];
        if (!selection || String(selection.status || "upcoming").toLowerCase() !== "upcoming") return;

        const input = document.getElementById(`input-${matchId}`);
        const tauntInput = document.getElementById(`taunt-${matchId}`);
        const effectiveMin = getEffectiveMinStake(selection.minStake);
        const stakeVal = parseInt(input?.value || "0", 10) || 0;
        const tauntText = String(tauntInput?.value || "").trim();

        if (stakeVal < effectiveMin) {
            showToast(`Số điểm tối thiểu là ${formatCoins(effectiveMin)}.`, "error");
            return;
        }
        if (currentUser && stakeVal > currentUser.total_points) {
            showToast("Số điểm không đủ.", "error");
            return;
        }
        if (tauntText.length > 30) {
            showToast("Câu gáy tối đa 30 ký tự.", "error");
            return;
        }

        const confirmLines = [
            `Xác nhận đặt ${formatCoins(stakeVal)} cho cửa ${choiceLabel(selection.choice)}?`,
        ];
        if (tauntText) confirmLines.push(`Câu gáy: "${tauntText}"`);
        if (!window.confirm(confirmLines.join("\n"))) return;

        const btn = document.getElementById(`confirm-btn-${matchId}`);
        if (!btn) return;
        btn.disabled = true;
        btn.textContent = "Đang xử lý...";

        try {
            const res = await fetch("/api/v1/bets", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    match_id: matchId,
                    choice: selection.choice,
                    stake: stakeVal,
                    taunt_text: tauntText || null,
                }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
                showToast(data.detail || "Đặt cược thất bại.", "error");
                btn.disabled = false;
                btn.textContent = "Xác nhận đặt cược";
                return;
            }

            placedBets.add(matchId);
            updateDisplayedPoints(data.remaining_points);
            showToast(`Đặt cược thành công. Còn lại ${formatCoins(data.remaining_points)}.`, "success");
            matchDetailCache.delete(matchId);
            try {
                await fetchUpcomingMatches();
                startTicker();
            } catch (refreshError) {
                console.error(refreshError);
            }
        } catch (error) {
            showToast("Lỗi kết nối. Vui lòng thử lại.", "error");
            btn.disabled = false;
            btn.textContent = "Xác nhận đặt cược";
        }
    };
})();
