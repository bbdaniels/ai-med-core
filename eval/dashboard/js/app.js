// AI-MED Evaluation Dashboard
// Adapted from TEECH — dynamic rubric discovery, profile-based comparisons

let data = null;
let currentResult = null;
let currentResultIndex = -1;
let originalTranscript = '';
let searchMatches = [];
let currentMatchIndex = -1;

// Sorting state
let sortColumn = null; // set after rubrics load
let sortDirection = 'desc';
let sortedResults = [];

// Global search state
let globalSearchQuery = '';
let filteredResults = null;

// Cache for loaded submission details
let submissionCache = {};

// Rubric metadata (populated on load)
let rubricKeys = [];       // ordered keys: ["scoring_rubric", "question_checklist", ...]
let rubricMeta = {};       // { key: { type: "rubric"|"checklist", displayName, ... } }

// Filter state
let selectedScenarioByView = {};   // { rubricKey: "all", psychometrics: "all" }
let selectedPsychometricsScale = '';
let selectedComparisonsScale = '';
let selectedComparisonsDimension = '';
let currentView = 'submissions';

// ============ Helpers ============

function getRubricType(rubric) {
    return 'categories' in rubric ? 'rubric' : 'checklist';
}

function getRubricDisplayName(key, rubric) {
    if (rubric.name) return rubric.name;
    return key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function getScoreLabel(rubricKey) {
    const r = data.rubrics[rubricKey];
    if (!r) return rubricKey;
    return getRubricType(r) === 'rubric' ? 'Score' : 'Completed';
}

function getSubmissionScore(submission, rubricKey) {
    const r = submission.results?.[rubricKey];
    if (!r) return { value: 0, max: 0, display: '--' };
    if ('total_score' in r) {
        return { value: r.total_score, max: r.max_score, display: `${r.total_score}/${r.max_score}` };
    }
    if ('completed' in r) {
        return { value: r.completed, max: r.total, display: `${r.completed}/${r.total}` };
    }
    return { value: 0, max: 0, display: '--' };
}

function isValidDuration(minutes) {
    return minutes != null && minutes <= 60;
}

function escapeHtml(text) {
    const d = document.createElement('div');
    d.textContent = text;
    return d.innerHTML;
}

function escapeRegExp(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function toggleCategory(element) {
    element.classList.toggle('collapsed');
}

function toTitleCase(key) {
    return key.replace(/([A-Z])/g, ' $1').replace(/^./, c => c.toUpperCase());
}

// ============ Data Loading ============

async function loadData() {
    try {
        const response = await fetch('data/index.json');
        data = await response.json();

        // Set page title
        document.getElementById('dashboard-title').textContent =
            data.project_name ? `${data.project_name} — Evaluation` : 'Evaluation Dashboard';
        document.title = data.project_name ? `${data.project_name} Evaluation` : 'Evaluation Dashboard';

        // Discover rubric types
        rubricKeys = Object.keys(data.rubrics || {});
        rubricKeys.forEach(key => {
            const rubric = data.rubrics[key];
            rubricMeta[key] = {
                type: getRubricType(rubric),
                displayName: getRubricDisplayName(key, rubric),
                source: rubric.source || 'transcript',
            };
        });

        // Set defaults
        if (rubricKeys.length > 0) {
            const firstRubric = rubricKeys.find(k => rubricMeta[k].type === 'rubric') || rubricKeys[0];
            sortColumn = `score_${firstRubric}`;
            selectedPsychometricsScale = rubricKeys[0];
            selectedComparisonsScale = rubricKeys[0];
        }

        // Build dynamic UI
        buildViewToggle();
        buildSubmissionsTableHeader();
        buildDynamicOverviews();
        buildPsychometricsScaleFilter();
        buildComparisonsFilters();

        // Render
        renderSummary();
        renderSubmissionsTable();
        populateScenarioFilters();

    } catch (error) {
        console.error('Error loading data:', error);
        document.getElementById('summary-stats').innerHTML =
            '<p style="color: red;">Error loading data. Make sure data/index.json exists.</p>';
    }
}

async function loadSubmissionDetail(uid, scenario) {
    const submission = data.submissions.find(s => s.uid === uid && s.scenario === scenario);
    if (!submission || !submission.transcript_file) return null;

    const filename = submission.transcript_file.replace('.txt', '');
    if (submissionCache[filename]) return submissionCache[filename];

    try {
        const response = await fetch(`data/submissions/${filename}.json`);
        const detail = await response.json();
        submissionCache[filename] = detail;
        return detail;
    } catch (error) {
        console.error(`Error loading submission ${filename}:`, error);
        return null;
    }
}

// ============ Dynamic UI Construction ============

function buildViewToggle() {
    const toggle = document.getElementById('view-toggle');
    // Insert rubric overview buttons before psychometrics
    const psychBtn = document.getElementById('view-psychometrics');

    rubricKeys.forEach(key => {
        const btn = document.createElement('button');
        btn.className = 'toggle-btn';
        btn.id = `view-overview-${key}`;
        btn.textContent = rubricMeta[key].displayName;
        btn.addEventListener('click', () => switchView(`overview-${key}`));
        toggle.insertBefore(btn, psychBtn);
    });

    // Add listeners for fixed buttons
    document.getElementById('view-submissions').addEventListener('click', () => switchView('submissions'));
    document.getElementById('view-psychometrics').addEventListener('click', () => switchView('psychometrics'));
    document.getElementById('view-comparisons').addEventListener('click', () => switchView('comparisons'));
}

function buildSubmissionsTableHeader() {
    const row = document.getElementById('submissions-thead-row');
    let html = `
        <th data-sort="uid" onclick="sortTable('uid')" class="sortable">UID<span class="sort-arrow"></span></th>
        <th data-sort="profile" onclick="sortTable('profile')" class="sortable">Profile<span class="sort-arrow"></span></th>
        <th data-sort="scenario" onclick="sortTable('scenario')" class="sortable">Scenario<span class="sort-arrow"></span></th>
        <th data-sort="submitted" onclick="sortTable('submitted')" class="sortable">Submitted<span class="sort-arrow"></span></th>
        <th data-sort="duration" onclick="sortTable('duration')" class="sortable">Duration<span class="sort-arrow"></span></th>
    `;

    rubricKeys.forEach(key => {
        const label = rubricMeta[key].displayName;
        const sortKey = `score_${key}`;
        const arrow = sortColumn === sortKey ? ' \u25BC' : '';
        html += `<th data-sort="${sortKey}" onclick="sortTable('${sortKey}')" class="sortable">${label}<span class="sort-arrow">${arrow}</span></th>`;
    });

    html += '<th>Action</th>';
    row.innerHTML = html;
}

function buildDynamicOverviews() {
    const container = document.getElementById('dynamic-overviews');
    container.innerHTML = '';

    rubricKeys.forEach(key => {
        const div = document.createElement('div');
        div.id = `overview-${key}`;
        div.className = 'overview-section hidden';
        div.innerHTML = `
            <div class="overview-controls">
                <label for="overview-scenario-${key}">Filter by scenario:</label>
                <select id="overview-scenario-${key}">
                    <option value="all">All Scenarios</option>
                </select>
            </div>
            <p class="overview-hint">Click any item to see detailed statistics</p>
            <div id="overview-content-${key}" class="overview-content"></div>
        `;
        container.appendChild(div);

        // Filter listener
        selectedScenarioByView[key] = 'all';
        div.querySelector(`#overview-scenario-${key}`).addEventListener('change', (e) => {
            selectedScenarioByView[key] = e.target.value;
            renderOverview(key);
        });
    });
}

function buildPsychometricsScaleFilter() {
    const select = document.getElementById('psychometrics-scale-filter');
    select.innerHTML = '';
    rubricKeys.forEach(key => {
        const opt = document.createElement('option');
        opt.value = key;
        opt.textContent = rubricMeta[key].displayName;
        select.appendChild(opt);
    });
    select.value = selectedPsychometricsScale;
}

function buildComparisonsFilters() {
    // Scale filter
    const scaleSelect = document.getElementById('comparisons-scale-filter');
    scaleSelect.innerHTML = '';
    rubricKeys.forEach(key => {
        const opt = document.createElement('option');
        opt.value = key;
        opt.textContent = rubricMeta[key].displayName;
        scaleSelect.appendChild(opt);
    });
    scaleSelect.value = selectedComparisonsScale;

    // Dimension filter (from profile keys)
    const dimSelect = document.getElementById('comparisons-dimension-filter');
    dimSelect.innerHTML = '';

    // Collect all profile keys
    const profileKeys = new Set();
    Object.values(data.profiles || {}).forEach(p => {
        Object.keys(p).forEach(k => profileKeys.add(k));
    });
    // Also add "scenario" as a comparison dimension
    const dimensions = ['scenario', ...Array.from(profileKeys)];
    dimensions.forEach(dim => {
        const opt = document.createElement('option');
        opt.value = dim;
        opt.textContent = dim === 'scenario' ? 'Scenario' : toTitleCase(dim);
        dimSelect.appendChild(opt);
    });
    selectedComparisonsDimension = dimensions[0] || 'scenario';
    dimSelect.value = selectedComparisonsDimension;
}

// ============ Summary ============

function renderSummary() {
    const stats = document.getElementById('summary-stats');
    const results = data.submissions || [];

    // Valid durations
    const validDurations = results.filter(r => isValidDuration(r.duration_minutes));
    const avgDuration = validDurations.length > 0
        ? validDurations.reduce((sum, r) => sum + r.duration_minutes, 0) / validDurations.length
        : 0;

    let html = `
        <div class="stat-box">
            <div class="value">${results.length}</div>
            <div class="label">Submissions</div>
        </div>
    `;

    // One stat per rubric
    rubricKeys.forEach(key => {
        const scores = results.map(r => getSubmissionScore(r, key));
        const validScores = scores.filter(s => s.max > 0);
        const avg = validScores.length > 0
            ? validScores.reduce((sum, s) => sum + s.value, 0) / validScores.length
            : 0;
        const maxScore = validScores.length > 0 ? validScores[0].max : 0;
        const label = rubricMeta[key].displayName;

        html += `
            <div class="stat-box">
                <div class="value">${avg.toFixed(1)}</div>
                <div class="label">Avg ${label} (of ${maxScore})</div>
            </div>
        `;
    });

    html += `
        <div class="stat-box">
            <div class="value">${avgDuration.toFixed(0)}</div>
            <div class="label">Avg Duration (min)</div>
        </div>
    `;

    // Timeline
    const submissionsByDay = {};
    results.forEach(r => {
        if (!r.submission_time) return;
        const dateMatch = r.submission_time.match(/(\d{4}-\d{2}-\d{2})/);
        const dateStr = dateMatch ? dateMatch[1] : r.submission_time.split(/[T\s]/)[0];
        submissionsByDay[dateStr] = (submissionsByDay[dateStr] || 0) + 1;
    });

    const dates = Object.keys(submissionsByDay).sort();
    let timelineHtml = '';
    if (dates.length > 0) {
        const startDate = new Date(dates[0]);
        const endDate = new Date(dates[dates.length - 1]);
        const allDates = [];
        for (let d = new Date(startDate); d <= endDate; d.setDate(d.getDate() + 1)) {
            allDates.push(d.toISOString().split('T')[0]);
        }
        const maxCount = Math.max(...Object.values(submissionsByDay));
        const yMax = Math.ceil(maxCount * 1.2) || 5;

        const bars = allDates.map(date => {
            const count = submissionsByDay[date] || 0;
            const heightPct = (count / yMax) * 100;
            const d = new Date(date + 'T12:00:00');
            const day = d.getDate();
            const tooltip = `${day} ${d.toLocaleString('en', {month: 'short'})}`;
            const label = day === 1 ? d.toLocaleString('en', {month: 'short'}) : String(day);
            return `<div class="tl-bar" title="${tooltip}: ${count}">
                <div class="tl-fill" style="height: ${heightPct}%"></div>
                <div class="tl-label">${label}</div>
            </div>`;
        }).join('');

        const yAxis = [yMax, Math.round(yMax/2), 0].map(v =>
            `<div class="tl-y-tick"><span>${v}</span></div>`
        ).join('');

        timelineHtml = `
            <div class="tl-y-axis">${yAxis}</div>
            <div class="tl-bars">${bars}</div>
        `;
    }

    html += `
        <div class="timeline-container">
            <div class="timeline-title">Submissions by Day</div>
            <div class="timeline-chart">${timelineHtml}</div>
        </div>
    `;

    stats.innerHTML = html;
}

// ============ Submissions Table ============

function renderSubmissionsTable() {
    const tbody = document.querySelector('#submissions-table tbody');
    tbody.innerHTML = '';

    const sourceResults = filteredResults !== null ? filteredResults : data.submissions;
    const indexedResults = sourceResults.map(result => {
        const originalIndex = data.submissions.indexOf(result);
        return { ...result, originalIndex };
    });

    // Sort
    indexedResults.sort((a, b) => {
        let aVal, bVal;
        if (sortColumn === 'uid') {
            aVal = a.uid; bVal = b.uid;
        } else if (sortColumn === 'profile') {
            aVal = a.profile_id || ''; bVal = b.profile_id || '';
        } else if (sortColumn === 'scenario') {
            aVal = a.scenario; bVal = b.scenario;
        } else if (sortColumn === 'submitted') {
            aVal = a.submission_time || ''; bVal = b.submission_time || '';
        } else if (sortColumn === 'duration') {
            const aValid = isValidDuration(a.duration_minutes);
            const bValid = isValidDuration(b.duration_minutes);
            if (!aValid && !bValid) return 0;
            if (!aValid) return 1;
            if (!bValid) return -1;
            aVal = a.duration_minutes; bVal = b.duration_minutes;
        } else if (sortColumn && sortColumn.startsWith('score_')) {
            const rk = sortColumn.replace('score_', '');
            aVal = getSubmissionScore(a, rk).value;
            bVal = getSubmissionScore(b, rk).value;
        } else {
            return 0;
        }
        if (aVal < bVal) return sortDirection === 'asc' ? -1 : 1;
        if (aVal > bVal) return sortDirection === 'asc' ? 1 : -1;
        return 0;
    });

    sortedResults = indexedResults;
    updateSortHeaders();

    indexedResults.forEach((result, sortedIndex) => {
        const tr = document.createElement('tr');
        const durationDisplay = isValidDuration(result.duration_minutes)
            ? `${result.duration_minutes.toFixed(0)} min` : '--';
        const submittedDate = result.submission_time
            ? new Date(result.submission_time).toLocaleDateString() : '--';
        const profileLabel = result.profile_id
            ? result.profile_id.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()).substring(0, 30)
            : '--';

        let html = `
            <td>${result.uid}</td>
            <td title="${escapeHtml(result.profile_id || '')}">${escapeHtml(profileLabel)}</td>
            <td>${escapeHtml(result.scenario)}</td>
            <td>${submittedDate}</td>
            <td>${durationDisplay}</td>
        `;

        rubricKeys.forEach(key => {
            html += `<td>${getSubmissionScore(result, key).display}</td>`;
        });

        html += `<td><button class="btn" onclick="showDetailFromSorted(${sortedIndex})">View</button></td>`;
        tr.innerHTML = html;
        tbody.appendChild(tr);
    });
}

function updateSortHeaders() {
    const headers = document.querySelectorAll('#submissions-table th[data-sort]');
    headers.forEach(th => {
        const col = th.dataset.sort;
        const arrow = th.querySelector('.sort-arrow');
        if (col === sortColumn) {
            arrow.textContent = sortDirection === 'asc' ? ' \u25B2' : ' \u25BC';
        } else {
            arrow.textContent = '';
        }
    });
}

function sortTable(column) {
    if (sortColumn === column) {
        sortDirection = sortDirection === 'asc' ? 'desc' : 'asc';
    } else {
        sortColumn = column;
        sortDirection = (column === 'uid' || column === 'scenario' || column === 'profile') ? 'asc' : 'desc';
    }
    renderSubmissionsTable();
}

// ============ Scenario Filters ============

function getUniqueScenarios() {
    const scenarios = new Set();
    data.submissions.forEach(r => scenarios.add(r.scenario));
    return Array.from(scenarios).sort();
}

function populateScenarioFilters() {
    const scenarios = getUniqueScenarios();

    // Populate each overview's scenario filter
    rubricKeys.forEach(key => {
        const select = document.getElementById(`overview-scenario-${key}`);
        if (select) {
            select.innerHTML = '<option value="all">All Scenarios</option>';
            scenarios.forEach(s => select.innerHTML += `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`);
        }
    });

    // Psychometrics scenario filter
    const psychSelect = document.getElementById('psychometrics-scenario-filter');
    psychSelect.innerHTML = '<option value="all">All Scenarios</option>';
    scenarios.forEach(s => psychSelect.innerHTML += `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`);
}

function getFilteredResults(scenario) {
    if (scenario === 'all') return data.submissions;
    return data.submissions.filter(r => r.scenario === scenario);
}

// ============ View Switching ============

function switchView(view) {
    currentView = view;

    // Update toggle buttons
    document.querySelectorAll('.toggle-btn').forEach(btn => btn.classList.remove('active'));
    const activeBtn = document.getElementById(`view-${view}`) || document.getElementById(`view-${view}`);
    if (activeBtn) activeBtn.classList.add('active');

    // Hide all views
    document.getElementById('submissions-view').classList.toggle('hidden', view !== 'submissions');
    rubricKeys.forEach(key => {
        const el = document.getElementById(`overview-${key}`);
        if (el) el.classList.toggle('hidden', view !== `overview-${key}`);
    });
    document.getElementById('psychometrics-overview').classList.toggle('hidden', view !== 'psychometrics');
    document.getElementById('comparisons-overview').classList.toggle('hidden', view !== 'comparisons');

    // Render content
    if (view.startsWith('overview-')) {
        const rubricKey = view.replace('overview-', '');
        renderOverview(rubricKey);
    } else if (view === 'psychometrics') {
        renderPsychometricsOverview();
    } else if (view === 'comparisons') {
        renderComparisonsOverview();
    }
}

// ============ Detail View ============

function parseTranscript(transcript) {
    const messages = [];
    const lines = transcript.split('\n');
    let currentRole = null;
    let currentContent = [];

    for (const line of lines) {
        if (line.startsWith('User:')) {
            if (currentRole && currentContent.length > 0) {
                messages.push({ role: currentRole, content: currentContent.join('\n').trim() });
            }
            currentRole = 'user';
            const afterColon = line.substring(5).trim();
            currentContent = afterColon ? [afterColon] : [];
        } else if (line.startsWith('Patient:') || line.startsWith('Assistant:')) {
            if (currentRole && currentContent.length > 0) {
                messages.push({ role: currentRole, content: currentContent.join('\n').trim() });
            }
            currentRole = 'assistant';
            const colonIndex = line.indexOf(':');
            const afterColon = line.substring(colonIndex + 1).trim();
            currentContent = afterColon ? [afterColon] : [];
        } else if (currentRole) {
            currentContent.push(line);
        }
    }

    if (currentRole && currentContent.length > 0) {
        messages.push({ role: currentRole, content: currentContent.join('\n').trim() });
    }

    return messages.filter(m => m.content.length > 0);
}

function renderTranscriptAsChat(messages) {
    const container = document.getElementById('transcript-content');
    container.innerHTML = '';

    messages.forEach((msg, index) => {
        const messageDiv = document.createElement('div');
        messageDiv.className = `chat-message ${msg.role}`;
        messageDiv.dataset.messageIndex = index;

        const label = document.createElement('div');
        label.className = 'chat-label';
        label.textContent = msg.role === 'user' ? 'Student' : 'Patient';

        const bubble = document.createElement('div');
        bubble.className = 'chat-bubble';
        bubble.textContent = msg.content;

        messageDiv.appendChild(label);
        messageDiv.appendChild(bubble);
        container.appendChild(messageDiv);
    });
}

let parsedMessages = [];

async function showDetailFromSorted(sortedIndex) {
    currentResultIndex = sortedIndex;
    const summaryResult = sortedResults[sortedIndex];
    const detailView = document.getElementById('detail-view');

    // Show loading
    detailView.classList.remove('hidden');
    document.getElementById('detail-header').innerHTML = '<div>Loading...</div>';
    document.getElementById('transcript-content').innerHTML = '<p>Loading transcript...</p>';

    document.getElementById('prev-detail').disabled = sortedIndex <= 0;
    document.getElementById('next-detail').disabled = sortedIndex >= sortedResults.length - 1;

    detailView.scrollIntoView({ behavior: 'smooth' });

    // Load full detail
    const fullDetail = await loadSubmissionDetail(summaryResult.uid, summaryResult.scenario);
    if (!fullDetail) {
        document.getElementById('detail-header').innerHTML = '<div style="color: red;">Error loading submission</div>';
        return;
    }

    currentResult = { ...fullDetail, ...summaryResult, ...fullDetail };
    originalTranscript = currentResult.transcript || '';
    parsedMessages = parseTranscript(originalTranscript);

    // Header
    const durationText = isValidDuration(currentResult.duration_minutes)
        ? `${currentResult.duration_minutes.toFixed(1)} min` : '--';

    let headerHtml = `
        <div><strong>UID:</strong> ${escapeHtml(currentResult.uid)}</div>
        <div><strong>Scenario:</strong> ${escapeHtml(currentResult.scenario)}</div>
        <div><strong>Duration:</strong> ${durationText}</div>
    `;

    // Show scores for each rubric
    rubricKeys.forEach(key => {
        const score = getSubmissionScore(currentResult, key);
        headerHtml += `<div><strong>${escapeHtml(rubricMeta[key].displayName)}:</strong> ${score.display}</div>`;
    });

    document.getElementById('detail-header').innerHTML = headerHtml;

    // Profile card
    if (currentResult.profile && Object.keys(currentResult.profile).length > 0) {
        const profileHtml = Object.entries(currentResult.profile)
            .map(([k, v]) => `<div class="profile-row"><span class="profile-label">${toTitleCase(k)}</span><span>${escapeHtml(String(v))}</span></div>`)
            .join('');
        const profileCard = document.createElement('div');
        profileCard.className = 'profile-card';
        profileCard.innerHTML = `<h4>Profile: ${escapeHtml(currentResult.profile_id || '')}</h4>${profileHtml}`;
        document.getElementById('detail-header').after(profileCard);
        // Clean up old profile card on next render
        const oldCards = document.querySelectorAll('.profile-card');
        if (oldCards.length > 1) oldCards[0].remove();
    }

    // Category score cards (for scoring rubrics)
    renderDetailScoreCards(currentResult);

    // Transcript
    renderTranscriptAsChat(parsedMessages);

    // Build detail tabs for rubrics
    buildDetailRubricTabs(currentResult);

    // AI notes (from first scoring rubric that has notes)
    let aiNotes = '(No notes)';
    for (const key of rubricKeys) {
        const notes = currentResult.results?.[key]?.overall_notes;
        if (notes) { aiNotes = notes; break; }
    }
    document.getElementById('ai-notes').textContent = aiNotes;

    // Source data section (for field-sourced rubrics)
    renderSourceDataSection(currentResult);

    // Reset search
    clearSearch();
}

function renderDetailScoreCards(result) {
    const container = document.getElementById('category-scores');
    container.innerHTML = '';

    rubricKeys.forEach(key => {
        const rubric = data.rubrics[key];
        const resultData = result.results?.[key];
        if (!resultData) return;

        if (rubricMeta[key].type === 'rubric' && rubric.categories) {
            rubric.categories.forEach(category => {
                const score = resultData.category_scores?.[category.name] || 0;
                const maxScore = category.max_points;
                const percentage = maxScore > 0 ? (score / maxScore) * 100 : 0;

                let scoreClass = 'low';
                if (percentage >= 70) scoreClass = 'high';
                else if (percentage >= 40) scoreClass = 'medium';

                const card = document.createElement('div');
                card.className = 'score-card';
                card.innerHTML = `
                    <div class="category-name">${escapeHtml(category.name)}</div>
                    <div class="score ${scoreClass}">${score}/${maxScore}</div>
                `;
                container.appendChild(card);
            });
        }
    });
}

function buildDetailRubricTabs(result) {
    const tabContainer = document.getElementById('detail-tab-buttons');
    const panelContainer = document.getElementById('detail-rubric-panels');
    tabContainer.innerHTML = '';
    panelContainer.innerHTML = '';

    // Only show transcript-sourced rubrics in the main tabs
    // Field-sourced rubrics are rendered in the source-data-section below
    const activeRubrics = rubricKeys.filter(key => {
        if (!result.results?.[key]) return false;
        const source = rubricMeta[key].source || 'transcript';
        return source === 'transcript';
    });

    activeRubrics.forEach((key, idx) => {
        const btn = document.createElement('button');
        btn.className = `tab-btn${idx === 0 ? ' active' : ''}`;
        btn.id = `tab-detail-${key}`;
        btn.textContent = rubricMeta[key].displayName;
        btn.onclick = () => switchDetailTab(key);
        tabContainer.appendChild(btn);

        const panel = document.createElement('div');
        panel.id = `detail-panel-${key}`;
        panel.className = `scoring-scrollable${idx > 0 ? ' hidden' : ''}`;
        panelContainer.appendChild(panel);

        // Render rubric content
        if (rubricMeta[key].type === 'rubric') {
            renderScoringRubricDetail(panel, data.rubrics[key], result.results[key], key);
        } else {
            renderChecklistDetail(panel, data.rubrics[key], result.results[key], key);
        }
    });
}

function switchDetailTab(activeKey) {
    rubricKeys.forEach(key => {
        const btn = document.getElementById(`tab-detail-${key}`);
        const panel = document.getElementById(`detail-panel-${key}`);
        if (btn) btn.classList.toggle('active', key === activeKey);
        if (panel) panel.classList.toggle('hidden', key !== activeKey);
    });

    // Update hint
    const rubric = data.rubrics[activeKey];
    const hint = document.getElementById('tab-hint');
    const source = rubric?.source || 'transcript';
    if (source === 'transcript') {
        hint.textContent = 'Click evidence to jump to transcript location';
    } else if (source.startsWith('field:')) {
        hint.textContent = `Click evidence to highlight in source text below`;
    }
}

function renderScoringRubricDetail(container, rubric, resultData, rubricKey) {
    container.innerHTML = '';
    const scores = {};
    (resultData.rubric_scores || []).forEach(s => { scores[s.id] = s; });

    rubric.categories.forEach(category => {
        const catDiv = document.createElement('div');
        catDiv.className = 'rubric-category collapsed';

        let itemsHtml = '';
        category.items.forEach(item => {
            const scoreData = scores[item.id] || { score: 0, evidence: null };
            const isTimeItem = item.data_source === 'survey_time';

            if (isTimeItem) {
                const timeEvidence = isValidDuration(currentResult.duration_minutes)
                    ? `${currentResult.duration_minutes.toFixed(1)} minutes recorded`
                    : 'Duration unavailable';
                itemsHtml += `
                    <div class="rubric-item">
                        <div class="rubric-item-header">
                            <span class="score-badge yes">${currentResult.time_score || 0}</span>
                            <span class="description">${escapeHtml(item.description)}</span>
                        </div>
                        <div class="evidence" style="cursor: default; background: #f0f0f0;">${timeEvidence}</div>
                    </div>`;
            } else {
                const badgeClass = scoreData.score ? 'yes' : 'no';
                const badgeText = scoreData.score ? '1' : '0';
                const evidenceText = scoreData.evidence || '';

                itemsHtml += `
                    <div class="rubric-item">
                        <div class="rubric-item-header">
                            <span class="score-badge ${badgeClass}">${badgeText}</span>
                            <span class="description">${escapeHtml(item.description)}</span>
                        </div>
                        ${evidenceText ? `<div class="evidence" onclick="jumpToEvidence('${escapeHtml(evidenceText).replace(/'/g, "\\'")}')">${escapeHtml(evidenceText)}</div>` : ''}
                    </div>`;
            }
        });

        const catScore = resultData.category_scores?.[category.name] || 0;
        catDiv.innerHTML = `
            <h4 onclick="toggleCategory(this.parentElement)">
                <span class="collapse-icon">\u25B6</span>
                <span>${escapeHtml(category.name)} (${catScore}/${category.max_points})</span>
            </h4>
            <div class="rubric-items">${itemsHtml}</div>
        `;
        container.appendChild(catDiv);
    });
}

function renderChecklistDetail(container, checklist, resultData, rubricKey) {
    container.innerHTML = '';
    const items = {};
    (resultData.items || []).forEach(item => { items[item.id] = item; });

    // Determine field name (asked vs present)
    const hasQuestions = checklist.sections.some(s => s.items.some(i => 'question' in i));
    const field = hasQuestions ? 'asked' : 'present';
    const source = checklist.source || 'transcript';
    const jumpFn = source === 'transcript' ? 'jumpToEvidence' : 'jumpToSourceEvidence';

    checklist.sections.forEach(section => {
        const sectionDiv = document.createElement('div');
        sectionDiv.className = 'checklist-section-group collapsed';

        let itemsHtml = '';
        section.items.forEach(item => {
            const itemData = items[item.id] || {};
            const checked = itemData[field] || false;
            const iconClass = checked ? 'yes' : 'no';
            const icon = checked ? '\u2713' : '\u2717';
            const evidenceText = itemData.evidence || '';
            const displayText = item.question || item.criterion || item.description || item.id;

            itemsHtml += `
                <div class="checklist-item">
                    <span class="check-icon ${iconClass}">${icon}</span>
                    <span class="checklist-question">${escapeHtml(displayText)}</span>
                    ${evidenceText ? `<div class="evidence" onclick="${jumpFn}('${escapeHtml(evidenceText).replace(/'/g, "\\'")}')">${escapeHtml(evidenceText)}</div>` : ''}
                </div>
            `;
        });

        const sectionCompleted = section.items.filter(i => items[i.id]?.[field]).length;
        sectionDiv.innerHTML = `
            <h4 onclick="toggleCategory(this.parentElement)">
                <span class="collapse-icon">\u25B6</span>
                <span>${escapeHtml(section.name)} (${sectionCompleted}/${section.items.length})</span>
            </h4>
            <div class="checklist-items">${itemsHtml}</div>
        `;
        container.appendChild(sectionDiv);
    });
}

function renderSourceDataSection(result) {
    const section = document.getElementById('source-data-section');
    section.innerHTML = '';

    // Show field-sourced rubrics with their source data in a split layout
    const fieldRubrics = rubricKeys.filter(k => {
        const source = data.rubrics[k]?.source || 'transcript';
        return source.startsWith('field:') && result.results?.[k];
    });

    if (fieldRubrics.length === 0) {
        section.classList.add('hidden');
        return;
    }

    section.classList.remove('hidden');
    fieldRubrics.forEach(key => {
        const source = data.rubrics[key].source;
        const fieldName = source.split(':')[1];
        const fieldValue = result.field_data?.[fieldName] || '';
        const score = getSubmissionScore(result, key);

        // Create a split-view container for this field-sourced rubric
        const wrapper = document.createElement('div');
        wrapper.className = 'field-rubric-section';

        const heading = document.createElement('h3');
        heading.textContent = `${rubricMeta[key].displayName} (${score.display})`;
        wrapper.appendChild(heading);

        const splitView = document.createElement('div');
        splitView.className = 'split-view';

        // Left: source field text
        const leftPanel = document.createElement('div');
        leftPanel.className = 'transcript-panel';
        leftPanel.innerHTML = `
            <div class="panel-header">
                <h3>Student Response: ${escapeHtml(toTitleCase(fieldName))}</h3>
            </div>
            <div class="source-data-box" id="source-data-${key}">${fieldValue
                ? escapeHtml(String(fieldValue))
                : '<em style="color: #999;">No response provided</em>'}</div>
        `;

        // Right: rubric/checklist results
        const rightPanel = document.createElement('div');
        rightPanel.className = 'scoring-panel';
        rightPanel.innerHTML = `
            <div class="panel-header">
                <p class="hint">Click evidence to highlight in source text</p>
            </div>
        `;
        const resultsContainer = document.createElement('div');
        resultsContainer.className = 'scoring-scrollable';

        if (rubricMeta[key].type === 'rubric') {
            renderScoringRubricDetail(resultsContainer, data.rubrics[key], result.results[key], key);
        } else {
            renderChecklistDetail(resultsContainer, data.rubrics[key], result.results[key], key);
        }
        rightPanel.appendChild(resultsContainer);

        splitView.appendChild(leftPanel);
        splitView.appendChild(rightPanel);
        wrapper.appendChild(splitView);
        section.appendChild(wrapper);
    });
}

// ============ Search ============

function performSearch(query) {
    if (!query || query.length < 2) {
        renderTranscriptAsChat(parsedMessages);
        searchMatches = [];
        currentMatchIndex = -1;
        updateSearchUI();
        return;
    }

    searchMatches = [];
    let globalMatchIdx = 0;

    parsedMessages.forEach((msg, msgIndex) => {
        const msgRegex = new RegExp(escapeRegExp(query), 'gi');
        let match;
        while ((match = msgRegex.exec(msg.content)) !== null) {
            searchMatches.push({
                messageIndex: msgIndex,
                start: match.index,
                end: match.index + match[0].length,
                text: match[0],
                globalIndex: globalMatchIdx++
            });
        }
    });

    if (searchMatches.length === 0) {
        renderTranscriptAsChat(parsedMessages);
        currentMatchIndex = -1;
        updateSearchUI();
        return;
    }

    currentMatchIndex = 0;
    highlightMatches();
    updateSearchUI();
    scrollToMatch(0);
}

function highlightMatches() {
    const container = document.getElementById('transcript-content');
    container.innerHTML = '';

    const matchesByMessage = {};
    searchMatches.forEach((match, idx) => {
        if (!matchesByMessage[match.messageIndex]) matchesByMessage[match.messageIndex] = [];
        matchesByMessage[match.messageIndex].push({ ...match, globalIndex: idx });
    });

    parsedMessages.forEach((msg, msgIndex) => {
        const messageDiv = document.createElement('div');
        messageDiv.className = `chat-message ${msg.role}`;

        const label = document.createElement('div');
        label.className = 'chat-label';
        label.textContent = msg.role === 'user' ? 'Student' : 'Patient';

        const bubble = document.createElement('div');
        bubble.className = 'chat-bubble';

        const msgMatches = matchesByMessage[msgIndex];
        if (msgMatches && msgMatches.length > 0) {
            let html = '';
            let lastIndex = 0;
            msgMatches.forEach(match => {
                html += escapeHtml(msg.content.substring(lastIndex, match.start));
                const activeClass = match.globalIndex === currentMatchIndex ? ' active' : '';
                html += `<mark class="search-highlight${activeClass}" data-match-index="${match.globalIndex}">${escapeHtml(match.text)}</mark>`;
                lastIndex = match.end;
            });
            html += escapeHtml(msg.content.substring(lastIndex));
            bubble.innerHTML = html;
        } else {
            bubble.textContent = msg.content;
        }

        messageDiv.appendChild(label);
        messageDiv.appendChild(bubble);
        container.appendChild(messageDiv);
    });
}

function scrollToMatch(index) {
    const mark = document.querySelector(`mark[data-match-index="${index}"]`);
    if (mark) mark.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function updateSearchUI() {
    const countSpan = document.getElementById('search-results-count');
    const prevBtn = document.getElementById('search-prev');
    const nextBtn = document.getElementById('search-next');

    if (searchMatches.length === 0) {
        countSpan.textContent = '';
        prevBtn.disabled = true;
        nextBtn.disabled = true;
    } else {
        countSpan.textContent = `${currentMatchIndex + 1} of ${searchMatches.length}`;
        prevBtn.disabled = searchMatches.length <= 1;
        nextBtn.disabled = searchMatches.length <= 1;
    }
}

function nextMatch() {
    if (searchMatches.length === 0) return;
    currentMatchIndex = (currentMatchIndex + 1) % searchMatches.length;
    highlightMatches();
    scrollToMatch(currentMatchIndex);
    updateSearchUI();
}

function prevMatch() {
    if (searchMatches.length === 0) return;
    currentMatchIndex = (currentMatchIndex - 1 + searchMatches.length) % searchMatches.length;
    highlightMatches();
    scrollToMatch(currentMatchIndex);
    updateSearchUI();
}

function clearSearch() {
    document.getElementById('transcript-search').value = '';
    if (parsedMessages.length > 0) renderTranscriptAsChat(parsedMessages);
    searchMatches = [];
    currentMatchIndex = -1;
    updateSearchUI();
}

// ============ Jump to Evidence ============

function jumpToEvidence(evidenceText) {
    const container = document.getElementById('transcript-content');
    let searchText = evidenceText.replace(/^["']|["']$/g, '').trim();
    const lowerSearch = searchText.toLowerCase();

    const stopWords = new Set(['the', 'a', 'an', 'is', 'are', 'was', 'were', 'have', 'has', 'had',
        'do', 'does', 'did', 'will', 'would', 'could', 'should', 'may', 'might',
        'you', 'your', 'they', 'their', 'any', 'some', 'other', 'been', 'being',
        'this', 'that', 'these', 'those', 'what', 'which', 'who', 'whom',
        'about', 'with', 'from', 'into', 'during', 'before', 'after']);

    const keyWords = searchText.toLowerCase().split(/\s+/).filter(w => w.length > 3 && !stopWords.has(w));

    function searchInMessage(msg) {
        const lowerContent = msg.content.toLowerCase();
        let idx = lowerContent.indexOf(lowerSearch);
        if (idx !== -1) return { score: 100, start: idx, end: Math.min(idx + searchText.length, msg.content.length) };

        if (lowerSearch.length > 40) {
            idx = lowerContent.indexOf(lowerSearch.substring(0, 40));
            if (idx !== -1) return { score: 90, start: idx, end: Math.min(idx + searchText.length, msg.content.length) };
        }

        if (keyWords.length >= 2) {
            const matched = keyWords.filter(w => lowerContent.includes(w));
            if (matched.length >= 2) {
                idx = lowerContent.indexOf(matched[0]);
                if (idx !== -1) {
                    let endIdx = idx;
                    matched.forEach(w => { const wi = lowerContent.indexOf(w); if (wi !== -1) endIdx = Math.max(endIdx, wi + w.length); });
                    return { score: 50 + matched.length * 10, start: idx, end: Math.min(endIdx + 10, msg.content.length) };
                }
            }
        }
        return null;
    }

    let bestScore = 0, foundMsgIndex = -1, foundStart = -1, foundEnd = -1;

    // Search user messages first
    for (let i = 0; i < parsedMessages.length; i++) {
        if (parsedMessages[i].role === 'user') {
            const result = searchInMessage(parsedMessages[i]);
            if (result && result.score > bestScore) {
                bestScore = result.score;
                foundMsgIndex = i; foundStart = result.start; foundEnd = result.end;
                if (bestScore >= 90) break;
            }
        }
    }

    if (bestScore < 50) {
        for (let i = 0; i < parsedMessages.length; i++) {
            const result = searchInMessage(parsedMessages[i]);
            if (result && result.score > bestScore) {
                bestScore = result.score;
                foundMsgIndex = i; foundStart = result.start; foundEnd = result.end;
                if (bestScore >= 90) break;
            }
        }
    }

    // Render with highlight
    container.innerHTML = '';
    parsedMessages.forEach((msg, msgIndex) => {
        const messageDiv = document.createElement('div');
        messageDiv.className = `chat-message ${msg.role}`;
        const label = document.createElement('div');
        label.className = 'chat-label';
        label.textContent = msg.role === 'user' ? 'Student' : 'Patient';
        const bubble = document.createElement('div');
        bubble.className = 'chat-bubble';

        if (msgIndex === foundMsgIndex) {
            const before = escapeHtml(msg.content.substring(0, foundStart));
            const highlighted = escapeHtml(msg.content.substring(foundStart, foundEnd));
            const after = escapeHtml(msg.content.substring(foundEnd));
            bubble.innerHTML = before + `<mark class="evidence-highlight">${highlighted}</mark>` + after;
        } else {
            bubble.textContent = msg.content;
        }

        messageDiv.appendChild(label);
        messageDiv.appendChild(bubble);
        container.appendChild(messageDiv);
    });

    if (foundMsgIndex !== -1) {
        const mark = container.querySelector('.evidence-highlight');
        if (mark) mark.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
}

function jumpToSourceEvidence(evidenceText) {
    // Find the source data box and highlight within it
    const boxes = document.querySelectorAll('.source-data-box');
    let searchText = evidenceText.replace(/^["']|["']$/g, '').trim();

    boxes.forEach(box => {
        const originalText = box.textContent;
        const idx = originalText.toLowerCase().indexOf(searchText.toLowerCase());
        if (idx !== -1) {
            const before = escapeHtml(originalText.substring(0, idx));
            const highlighted = escapeHtml(originalText.substring(idx, idx + searchText.length));
            const after = escapeHtml(originalText.substring(idx + searchText.length));
            box.innerHTML = before + `<mark class="evidence-highlight">${highlighted}</mark>` + after;
            const mark = box.querySelector('.evidence-highlight');
            if (mark) mark.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
    });
}

// ============ Overview Rendering ============

async function renderOverview(rubricKey) {
    const container = document.getElementById(`overview-content-${rubricKey}`);
    container.innerHTML = '<p class="loading">Loading submission details...</p>';

    const filteredData = getFilteredResults(selectedScenarioByView[rubricKey] || 'all');
    if (filteredData.length === 0) {
        container.innerHTML = '<p class="no-students">No submissions for this scenario</p>';
        return;
    }

    const detailedResults = await Promise.all(
        filteredData.map(result => loadSubmissionDetail(result.uid, result.scenario))
    );
    const validResults = detailedResults.filter(r => r !== null);
    if (validResults.length === 0) {
        container.innerHTML = '<p class="no-students">Could not load submission details</p>';
        return;
    }

    container.innerHTML = '';
    const rubric = data.rubrics[rubricKey];

    if (rubricMeta[rubricKey].type === 'rubric') {
        renderScoringRubricOverview(container, rubric, validResults, rubricKey);
    } else {
        renderChecklistOverview(container, rubric, validResults, rubricKey);
    }
}

function renderScoringRubricOverview(container, rubric, validResults, rubricKey) {
    const rubricStats = {};
    validResults.forEach(result => {
        const scores = result.results?.[rubricKey]?.rubric_scores || [];
        scores.forEach(score => {
            if (!rubricStats[score.id]) rubricStats[score.id] = { earned: 0, total: 0 };
            rubricStats[score.id].total++;
            if (score.score > 0) rubricStats[score.id].earned++;
        });
    });

    rubric.categories.forEach(category => {
        const catDiv = document.createElement('div');
        let itemsHtml = '';

        category.items.forEach(item => {
            const stats = rubricStats[item.id] || { earned: 0, total: validResults.length };
            const percentage = stats.total > 0 ? Math.round((stats.earned / stats.total) * 100) : 0;
            const isTimeItem = item.data_source === 'survey_time';

            let barClass = 'low';
            if (percentage >= 70) barClass = 'high';
            else if (percentage >= 40) barClass = 'medium';

            if (isTimeItem) {
                const avgTimeScore = validResults.reduce((sum, r) => sum + (r.time_score || 0), 0) / validResults.length;
                const maxPts = item.max_points || 20;
                itemsHtml += `
                    <div class="overview-item">
                        <div class="overview-item-info">
                            <span class="overview-item-name">${escapeHtml(item.description)}</span>
                            <span class="overview-item-stat">Avg: ${avgTimeScore.toFixed(1)}/${maxPts}</span>
                        </div>
                        <div class="progress-bar">
                            <div class="progress-fill high" style="width: ${(avgTimeScore/maxPts)*100}%"></div>
                        </div>
                    </div>`;
            } else {
                itemsHtml += `
                    <div class="overview-item clickable" data-rubric-key="${rubricKey}" data-type="rubric" data-item-id="${item.id}">
                        <div class="overview-item-info">
                            <span class="overview-item-name">${escapeHtml(item.description)}</span>
                            <span class="overview-item-stat">${stats.earned}/${stats.total} (${percentage}%)</span>
                        </div>
                        <div class="progress-bar">
                            <div class="progress-fill ${barClass}" style="width: ${percentage}%"></div>
                        </div>
                    </div>`;
            }
        });

        const catItems = category.items.filter(i => i.data_source !== 'survey_time');
        const catEarned = catItems.reduce((sum, item) => (rubricStats[item.id]?.earned || 0) + sum, 0);
        const catTotal = catItems.length * validResults.length;
        const catPercentage = catTotal > 0 ? Math.round((catEarned / catTotal) * 100) : 0;

        catDiv.className = 'overview-category collapsed';
        catDiv.innerHTML = `
            <h4 onclick="toggleCategory(this.parentElement)">
                <span class="collapse-icon">\u25B6</span>
                <span>${escapeHtml(category.name)} <span class="cat-stat">(${catPercentage}% average)</span></span>
            </h4>
            <div class="overview-items">${itemsHtml}</div>
        `;
        container.appendChild(catDiv);
    });

    // Click handler for overview items
    container.addEventListener('click', (e) => {
        const item = e.target.closest('.overview-item.clickable');
        if (item) showMeasureDetail(item.dataset.rubricKey, item.dataset.type, item.dataset.itemId);
    });
}

function renderChecklistOverview(container, checklist, validResults, rubricKey) {
    const hasQuestions = checklist.sections.some(s => s.items.some(i => 'question' in i));
    const field = hasQuestions ? 'asked' : 'present';
    const actionWord = hasQuestions ? 'asked' : 'included';

    const checklistStats = {};
    validResults.forEach(result => {
        const items = result.results?.[rubricKey]?.items || [];
        items.forEach(check => {
            if (!checklistStats[check.id]) checklistStats[check.id] = { done: 0, total: 0 };
            checklistStats[check.id].total++;
            if (check[field]) checklistStats[check.id].done++;
        });
    });

    checklist.sections.forEach(section => {
        const sectionDiv = document.createElement('div');
        let itemsHtml = '';

        section.items.forEach(item => {
            const stats = checklistStats[item.id] || { done: 0, total: validResults.length };
            const percentage = stats.total > 0 ? Math.round((stats.done / stats.total) * 100) : 0;

            let barClass = 'low';
            if (percentage >= 70) barClass = 'high';
            else if (percentage >= 40) barClass = 'medium';

            const displayText = item.question || item.criterion || item.description || item.id;

            itemsHtml += `
                <div class="overview-item clickable" data-rubric-key="${rubricKey}" data-type="checklist" data-item-id="${item.id}">
                    <div class="overview-item-info">
                        <span class="overview-item-name">${escapeHtml(displayText)}</span>
                        <span class="overview-item-stat">${stats.done}/${stats.total} (${percentage}%)</span>
                    </div>
                    <div class="progress-bar">
                        <div class="progress-fill ${barClass}" style="width: ${percentage}%"></div>
                    </div>
                </div>`;
        });

        const secDone = section.items.reduce((sum, item) => (checklistStats[item.id]?.done || 0) + sum, 0);
        const secTotal = section.items.length * validResults.length;
        const secPercentage = secTotal > 0 ? Math.round((secDone / secTotal) * 100) : 0;

        sectionDiv.className = 'overview-category collapsed';
        sectionDiv.innerHTML = `
            <h4 onclick="toggleCategory(this.parentElement)">
                <span class="collapse-icon">\u25B6</span>
                <span>${escapeHtml(section.name)} <span class="cat-stat">(${secPercentage}% ${actionWord})</span></span>
            </h4>
            <div class="overview-items">${itemsHtml}</div>
        `;
        container.appendChild(sectionDiv);
    });

    container.addEventListener('click', (e) => {
        const item = e.target.closest('.overview-item.clickable');
        if (item) showMeasureDetail(item.dataset.rubricKey, item.dataset.type, item.dataset.itemId);
    });
}

// ============ Measure Detail Modal ============

async function showMeasureDetail(rubricKey, type, itemId) {
    const statsSection = document.getElementById('global-stats');
    const titleEl = document.getElementById('global-stats-title');
    const contentEl = document.getElementById('global-stats-content');

    const scenarioFilter = selectedScenarioByView[rubricKey] || 'all';
    const filteredData = getFilteredResults(scenarioFilter);

    statsSection.classList.remove('hidden');
    contentEl.innerHTML = '<p class="loading">Loading submission details...</p>';

    const detailedResults = await Promise.all(
        filteredData.map(result => loadSubmissionDetail(result.uid, result.scenario))
    );
    const validResults = detailedResults.filter(r => r !== null);

    const rubric = data.rubrics[rubricKey];
    let item = null;
    let parentName = '';

    if (type === 'rubric' && rubric.categories) {
        for (const cat of rubric.categories) {
            const found = cat.items.find(i => i.id === itemId);
            if (found) { item = found; parentName = cat.name; break; }
        }
    } else if (rubric.sections) {
        for (const sec of rubric.sections) {
            const found = sec.items.find(i => i.id === itemId);
            if (found) { item = found; parentName = sec.name; break; }
        }
    }
    if (!item) return;

    const displayText = item.description || item.question || item.criterion || item.id;
    titleEl.textContent = `${rubricMeta[rubricKey].displayName}: ${displayText}`;

    // Get per-student results
    const hasQuestions = rubric.sections?.some(s => s.items.some(i => 'question' in i));
    const field = type === 'rubric' ? 'score' : (hasQuestions ? 'asked' : 'present');
    const passField = type === 'rubric' ? (r => r.score > 0) : (r => r[field]);

    const results = [];
    validResults.forEach(result => {
        const originalIndex = data.submissions.findIndex(r => r.uid === result.uid);
        let itemList;
        if (type === 'rubric') {
            itemList = result.results?.[rubricKey]?.rubric_scores || [];
        } else {
            itemList = result.results?.[rubricKey]?.items || [];
        }
        const itemResult = itemList.find(i => i.id === itemId);
        if (itemResult) {
            results.push({
                uid: result.uid,
                scenario: result.scenario,
                pass: passField(itemResult),
                evidence: itemResult.evidence,
                originalIndex,
            });
        }
    });

    const passed = results.filter(r => r.pass).length;
    const percentage = results.length > 0 ? Math.round((passed / results.length) * 100) : 0;
    const passLabel = type === 'rubric' ? 'earned point' : (hasQuestions ? 'asked' : 'included');

    contentEl.innerHTML = `
        <div class="measure-summary">
            <div class="measure-stat-box">
                <div class="stat-value">${passed}/${results.length}</div>
                <div class="stat-label">Students ${passLabel}</div>
            </div>
            <div class="measure-stat-box">
                <div class="stat-value">${percentage}%</div>
                <div class="stat-label">Rate</div>
            </div>
        </div>
        <div class="measure-category">Section: ${escapeHtml(parentName)}</div>
        <div class="measure-results">
            <h4>Students who ${passLabel} (${passed})</h4>
            <div class="student-list earned">
                ${results.filter(r => r.pass).map(r => `
                    <div class="student-row" data-original-index="${r.originalIndex}">
                        <span class="student-uid">${escapeHtml(r.uid)}</span>
                        <span class="student-scenario">${escapeHtml(r.scenario)}</span>
                        ${r.evidence ? `<div class="student-evidence">"${escapeHtml(r.evidence)}"</div>` : ''}
                    </div>
                `).join('') || '<p class="no-students">No students</p>'}
            </div>
            <h4>Students who did not (${results.length - passed})</h4>
            <div class="student-list not-earned">
                ${results.filter(r => !r.pass).map(r => `
                    <div class="student-row" data-original-index="${r.originalIndex}">
                        <span class="student-uid">${escapeHtml(r.uid)}</span>
                        <span class="student-scenario">${escapeHtml(r.scenario)}</span>
                    </div>
                `).join('') || '<p class="no-students">No students</p>'}
            </div>
        </div>
    `;

    statsSection.classList.remove('hidden');
    statsSection.scrollIntoView({ behavior: 'smooth' });
}

// ============ Psychometrics ============

function computeMean(values) { return values.length === 0 ? 0 : values.reduce((s, v) => s + v, 0) / values.length; }
function computeSD(values) {
    if (values.length < 2) return 0;
    const mean = computeMean(values);
    return Math.sqrt(values.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / (values.length - 1));
}
function computeCorrelation(x, y) {
    if (x.length !== y.length || x.length < 3) return 0;
    const mx = computeMean(x), my = computeMean(y);
    let num = 0, dx2 = 0, dy2 = 0;
    for (let i = 0; i < x.length; i++) {
        const a = x[i] - mx, b = y[i] - my;
        num += a * b; dx2 += a * a; dy2 += b * b;
    }
    const den = Math.sqrt(dx2 * dy2);
    return den === 0 ? 0 : num / den;
}

function computeCronbachAlpha(itemMatrix) {
    const k = itemMatrix.length;
    if (k < 2) return 0;
    const n = itemMatrix[0].length;
    if (n < 2) return 0;

    const totalScores = [];
    for (let j = 0; j < n; j++) {
        let total = 0;
        for (let i = 0; i < k; i++) total += itemMatrix[i][j];
        totalScores.push(total);
    }

    const varTotal = computeSD(totalScores) ** 2;
    if (varTotal === 0) return 0;

    let sumItemVar = 0;
    for (let i = 0; i < k; i++) {
        const p = computeMean(itemMatrix[i]);
        sumItemVar += p * (1 - p);
    }

    return (k / (k - 1)) * (1 - sumItemVar / varTotal);
}

function flagItem(p, rit) {
    const flags = [];
    if (p < 0.15) flags.push({ type: 'too-hard', label: 'Too hard' });
    if (p > 0.85) flags.push({ type: 'too-easy', label: 'Too easy' });
    if (rit < 0.20) flags.push({ type: 'low-disc', label: 'Low r_it' });
    return flags.length > 0 ? flags : [{ type: 'ok', label: 'OK' }];
}

async function renderPsychometricsOverview() {
    const reliabilityContainer = document.getElementById('reliability-summary');
    const itemAnalysisContainer = document.getElementById('item-analysis-content');
    const problematicContainer = document.getElementById('problematic-items');
    const distributionContainer = document.getElementById('score-distributions');
    const pcaContainer = document.getElementById('pca-analysis');

    reliabilityContainer.innerHTML = '<p class="loading">Loading submission details...</p>';
    itemAnalysisContainer.innerHTML = '';
    problematicContainer.innerHTML = '';
    distributionContainer.innerHTML = '';
    pcaContainer.innerHTML = '';

    const psychScenario = document.getElementById('psychometrics-scenario-filter').value;
    const filteredData = getFilteredResults(psychScenario);

    if (filteredData.length === 0) {
        reliabilityContainer.innerHTML = '<p class="no-students">No submissions for this scenario</p>';
        return;
    }

    const detailedResults = await Promise.all(
        filteredData.map(result => loadSubmissionDetail(result.uid, result.scenario))
    );
    const validResults = detailedResults.filter(r => r !== null);
    if (validResults.length === 0) {
        reliabilityContainer.innerHTML = '<p class="no-students">Could not load submission details</p>';
        return;
    }

    const rubric = data.rubrics[selectedPsychometricsScale];
    if (!rubric) return;

    const rType = rubricMeta[selectedPsychometricsScale].type;

    // Build item matrix
    let itemMatrix = [];
    let itemInfo = [];
    let totalScores = [];

    if (rType === 'rubric') {
        const allItems = [];
        rubric.categories.forEach(cat => {
            cat.items.forEach(item => {
                if (item.data_source !== 'survey_time' && item.scoring === 'binary') {
                    allItems.push({ ...item, category: cat.name });
                }
            });
        });

        allItems.forEach(item => {
            const responses = validResults.map(r => {
                const score = r.results?.[selectedPsychometricsScale]?.rubric_scores?.find(s => s.id === item.id);
                return score ? (score.score > 0 ? 1 : 0) : 0;
            });
            itemMatrix.push(responses);
            itemInfo.push(item);
        });

        totalScores = validResults.map(r =>
            allItems.reduce((sum, item) => {
                const score = r.results?.[selectedPsychometricsScale]?.rubric_scores?.find(s => s.id === item.id);
                return sum + (score && score.score > 0 ? 1 : 0);
            }, 0)
        );
    } else {
        const hasQuestions = rubric.sections.some(s => s.items.some(i => 'question' in i));
        const field = hasQuestions ? 'asked' : 'present';

        const allItems = [];
        rubric.sections.forEach(sec => {
            sec.items.forEach(item => {
                allItems.push({ ...item, category: sec.name, description: item.question || item.criterion || item.id });
            });
        });

        allItems.forEach(item => {
            const responses = validResults.map(r => {
                const check = r.results?.[selectedPsychometricsScale]?.items?.find(c => c.id === item.id);
                return check ? (check[field] ? 1 : 0) : 0;
            });
            itemMatrix.push(responses);
            itemInfo.push(item);
        });

        totalScores = validResults.map(r =>
            allItems.reduce((sum, item) => {
                const check = r.results?.[selectedPsychometricsScale]?.items?.find(c => c.id === item.id);
                return sum + (check && check[field] ? 1 : 0);
            }, 0)
        );
    }

    if (itemMatrix.length === 0) {
        reliabilityContainer.innerHTML = '<p class="no-students">No items found for analysis</p>';
        return;
    }

    // Reliability
    const overallAlpha = computeCronbachAlpha(itemMatrix);
    const totalSD = computeSD(totalScores);
    const sem = totalSD * Math.sqrt(1 - overallAlpha);

    const alphaClass = overallAlpha >= 0.8 ? 'good' : overallAlpha >= 0.7 ? 'acceptable' : 'poor';

    reliabilityContainer.innerHTML = `
        <div class="reliability-card ${alphaClass}">
            <div class="scale-name">${escapeHtml(rubricMeta[selectedPsychometricsScale].displayName)}</div>
            <div class="alpha-value">\u03B1 = ${overallAlpha.toFixed(2)}</div>
            <div class="alpha-label">Cronbach's Alpha (${itemMatrix.length} items)</div>
        </div>
        <div class="sem-display">
            <div class="sem-value">SEM = ${sem.toFixed(2)}</div>
            <div class="sem-label">Standard Error of Measurement</div>
        </div>
    `;

    // Item analysis
    const itemStats = itemInfo.map((item, i) => {
        const p = computeMean(itemMatrix[i]);
        const rit = computeCorrelation(itemMatrix[i], totalScores);
        const flags = flagItem(p, rit);
        return { ...item, p, rit, flags };
    });

    const categoryStats = {};
    itemStats.forEach(item => {
        if (!categoryStats[item.category]) categoryStats[item.category] = [];
        categoryStats[item.category].push(item);
    });

    let itemHtml = '<h3 class="psychometrics-section-title">Item Analysis</h3>';
    Object.entries(categoryStats).forEach(([catName, items]) => {
        const catMatrix = items.map(item => {
            const idx = itemInfo.findIndex(i => i.id === item.id);
            return itemMatrix[idx];
        });
        const catAlpha = catMatrix.length >= 2 ? computeCronbachAlpha(catMatrix) : 0;

        const rows = items.map(item => `
            <tr>
                <td class="item-id">${escapeHtml(item.id)}</td>
                <td>${escapeHtml(item.description || item.question || item.criterion || '')}</td>
                <td class="numeric">${item.p.toFixed(2)}</td>
                <td class="numeric">${item.rit.toFixed(2)}</td>
                <td>${item.flags.map(f => `<span class="item-flag ${f.type}">${f.label}</span>`).join(' ')}</td>
            </tr>
        `).join('');

        itemHtml += `
            <div class="overview-category collapsed">
                <h4 onclick="toggleCategory(this.parentElement)">
                    <span class="collapse-icon">\u25B6</span>
                    <span>${escapeHtml(catName)} <span class="cat-stat">(\u03B1 = ${catAlpha.toFixed(2)}, ${items.length} items)</span></span>
                </h4>
                <div class="overview-items">
                    <table class="item-analysis-table">
                        <thead><tr><th>ID</th><th>Description</th><th>Difficulty (p)</th><th>Item-Total (r)</th><th>Flag</th></tr></thead>
                        <tbody>${rows}</tbody>
                    </table>
                </div>
            </div>
        `;
    });
    itemAnalysisContainer.innerHTML = itemHtml;

    // Problematic items
    const problematic = itemStats.filter(item => !item.flags.some(f => f.type === 'ok'));
    if (problematic.length > 0) {
        problematicContainer.innerHTML = `
            <h3 class="psychometrics-section-title">Problematic Items (${problematic.length})</h3>
            <div class="problematic-items-list">${problematic.map(item => `
                <div class="problematic-item">
                    <span class="item-name">${escapeHtml(item.id)}</span>:
                    ${item.flags.filter(f => f.type !== 'ok').map(f => {
                        if (f.type === 'too-hard') return `p = ${item.p.toFixed(2)} (too difficult)`;
                        if (f.type === 'too-easy') return `p = ${item.p.toFixed(2)} (too easy)`;
                        if (f.type === 'low-disc') return `r_it = ${item.rit.toFixed(2)} (low discrimination)`;
                        return f.label;
                    }).join(', ')}
                </div>
            `).join('')}</div>
        `;
    } else {
        problematicContainer.innerHTML = `
            <h3 class="psychometrics-section-title">Problematic Items</h3>
            <p style="color: var(--success-color); font-style: italic;">No items flagged.</p>
        `;
    }

    // Score distribution
    const scoreMin = Math.min(...totalScores);
    const scoreMax = Math.max(...totalScores);
    const scoreMean = computeMean(totalScores);
    const scoreSD = computeSD(totalScores);
    const numBins = Math.min(10, scoreMax - scoreMin + 1);
    const binWidth = (scoreMax - scoreMin + 1) / numBins;
    const bins = Array(numBins).fill(0);
    totalScores.forEach(score => {
        const binIdx = Math.min(Math.floor((score - scoreMin) / binWidth), numBins - 1);
        bins[binIdx]++;
    });
    const maxBinCount = Math.max(...bins);

    distributionContainer.innerHTML = `
        <h3 class="psychometrics-section-title">Score Distribution</h3>
        <div class="histogram">${bins.map(count =>
            `<div class="histogram-bar" style="height: ${maxBinCount > 0 ? (count / maxBinCount) * 100 : 0}%" title="${count} submissions"></div>`
        ).join('')}</div>
        <div class="histogram-labels"><span>${scoreMin}</span><span>${scoreMax}</span></div>
        <div class="distribution-stats">
            <div class="stat"><span class="stat-label">Mean:</span> <span class="stat-value">${scoreMean.toFixed(1)}</span></div>
            <div class="stat"><span class="stat-label">SD:</span> <span class="stat-value">${scoreSD.toFixed(1)}</span></div>
            <div class="stat"><span class="stat-label">Range:</span> <span class="stat-value">${scoreMin}-${scoreMax}</span></div>
            <div class="stat"><span class="stat-label">N:</span> <span class="stat-value">${validResults.length}</span></div>
        </div>
    `;
}

// ============ Comparisons ============

function kruskalWallisTest(groups) {
    const allValues = [];
    groups.forEach((group, gi) => {
        group.forEach(val => allValues.push({ value: val, group: gi }));
    });
    if (allValues.length < 3) return { H: 0, p: 1, df: groups.length - 1 };

    allValues.sort((a, b) => a.value - b.value);
    let rank = 1;
    for (let i = 0; i < allValues.length; i++) {
        let j = i;
        while (j < allValues.length - 1 && allValues[j + 1].value === allValues[i].value) j++;
        const avgRank = (rank + rank + (j - i)) / 2;
        for (let k = i; k <= j; k++) allValues[k].rank = avgRank;
        rank += (j - i + 1);
        i = j;
    }

    const n = allValues.length;
    const groupRankSums = groups.map(() => 0);
    const groupSizes = groups.map(g => g.length);
    allValues.forEach(item => { groupRankSums[item.group] += item.rank; });

    let H = 0;
    for (let i = 0; i < groups.length; i++) {
        if (groupSizes[i] > 0) H += (groupRankSums[i] ** 2) / groupSizes[i];
    }
    H = (12 / (n * (n + 1))) * H - 3 * (n + 1);

    const df = groups.length - 1;
    const p = 1 - chiSquareCDF(H, df);
    return { H, p, df };
}

function chiSquareCDF(x, df) {
    if (x <= 0) return 0;
    return gammaCDF(x / 2, df / 2);
}

function gammaCDF(x, a) {
    if (x <= 0) return 0;
    if (a <= 0) return 1;
    let sum = 0, term = 1 / a;
    sum = term;
    for (let n = 1; n < 100; n++) {
        term *= x / (a + n);
        sum += term;
        if (Math.abs(term) < 1e-10) break;
    }
    return sum * Math.exp(-x + a * Math.log(x) - logGamma(a));
}

function logGamma(x) {
    if (x <= 0) return 0;
    const c = [76.18009172947146, -86.50532032941677, 24.01409824083091,
               -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
    let y = x, tmp = x + 5.5;
    tmp -= (x + 0.5) * Math.log(tmp);
    let ser = 1.000000000190015;
    for (let j = 0; j < 6; j++) ser += c[j] / ++y;
    return -tmp + Math.log(2.5066282746310005 * ser / x);
}

async function renderComparisonsOverview() {
    const scoreContainer = document.getElementById('score-comparison');
    const categoryContainer = document.getElementById('category-comparison');
    const difContainer = document.getElementById('dif-analysis');

    scoreContainer.innerHTML = '<p class="loading">Loading submission details...</p>';
    categoryContainer.innerHTML = '';
    difContainer.innerHTML = '';

    const detailedResults = await Promise.all(
        data.submissions.map(result => loadSubmissionDetail(result.uid, result.scenario))
    );
    const validResults = detailedResults.filter(r => r !== null);

    if (validResults.length === 0) {
        scoreContainer.innerHTML = '<p class="no-students">Could not load submission details</p>';
        return;
    }

    const rubric = data.rubrics[selectedComparisonsScale];
    if (!rubric) return;

    const rType = rubricMeta[selectedComparisonsScale].type;
    const dim = selectedComparisonsDimension;

    // Group results by selected dimension
    function getGroupValue(result) {
        if (dim === 'scenario') return result.scenario || 'Unknown';
        const profile = result.profile || data.profiles?.[result.profile_id] || {};
        const val = profile[dim];
        if (val == null) return 'Unknown';
        return String(val);
    }

    const groupNames = [];
    const groupMap = {};
    validResults.forEach(r => {
        const gv = getGroupValue(r);
        if (!groupMap[gv]) { groupMap[gv] = []; groupNames.push(gv); }
        groupMap[gv].push(r);
    });
    groupNames.sort();

    // Score extraction
    function getScore(r) {
        const res = r.results?.[selectedComparisonsScale];
        if (!res) return 0;
        if ('total_score' in res) return res.total_score;
        if ('completed' in res) return res.completed;
        return 0;
    }

    function getMaxScore() {
        const res = data.submissions[0]?.results?.[selectedComparisonsScale];
        if (!res) return 0;
        if ('max_score' in res) return res.max_score;
        if ('total' in res) return res.total;
        return 0;
    }

    const maxScore = getMaxScore();
    const scaleLabel = rubricMeta[selectedComparisonsScale].displayName;

    // Stats by group
    const groupStats = groupNames.map(name => {
        const scores = groupMap[name].map(getScore);
        return {
            name,
            n: scores.length,
            mean: computeMean(scores),
            sd: scores.length > 1 ? computeSD(scores) : 0,
            scores,
        };
    });

    // KW test
    const kwResult = kruskalWallisTest(groupNames.map(n => groupMap[n].map(getScore)));
    const pValue = kwResult.p < 0.001 ? '< 0.001' : kwResult.p.toFixed(3);
    const sigClass = kwResult.p < 0.05 ? 'significant' : 'not-significant';

    const maxMean = Math.max(...groupStats.map(s => s.mean));
    const barHtml = groupStats.map(stat => `
        <div class="comparison-row">
            <div class="comparison-label">${escapeHtml(stat.name)}</div>
            <div class="comparison-bar-container">
                <div class="comparison-bar" style="width: ${maxMean > 0 ? (stat.mean / maxMean) * 100 : 0}%"></div>
                <span class="comparison-value">${stat.mean.toFixed(1)} \u00B1 ${stat.sd.toFixed(1)}</span>
            </div>
            <div class="comparison-n">n=${stat.n}</div>
        </div>
    `).join('');

    scoreContainer.innerHTML = `
        <h3 class="psychometrics-section-title">${escapeHtml(scaleLabel)} by ${escapeHtml(dim === 'scenario' ? 'Scenario' : toTitleCase(dim))}</h3>
        <div class="comparison-chart">${barHtml}</div>
        <div class="statistical-test ${sigClass}">
            <strong>Kruskal-Wallis test:</strong> H(${kwResult.df}) = ${kwResult.H.toFixed(2)}, p = ${pValue}
            ${kwResult.p < 0.05 ? '<span class="sig-indicator">*</span>' : ''}
        </div>
    `;

    // DIF analysis
    let difHtml = `<h3 class="psychometrics-section-title">Differential Item Functioning (DIF)</h3>`;
    difHtml += `<p class="overview-hint">Items with different pass rates across ${dim === 'scenario' ? 'scenarios' : toTitleCase(dim).toLowerCase() + ' groups'}</p>`;

    const difItems = [];
    const hasQuestions = rubric.sections?.some(s => s.items.some(i => 'question' in i));
    const field = hasQuestions ? 'asked' : 'present';

    function getItemPass(result, itemId) {
        if (rType === 'rubric') {
            const score = result.results?.[selectedComparisonsScale]?.rubric_scores?.find(s => s.id === itemId);
            return score && score.score > 0 ? 1 : 0;
        }
        const check = result.results?.[selectedComparisonsScale]?.items?.find(c => c.id === itemId);
        return check && check[field] ? 1 : 0;
    }

    const allItems = [];
    if (rType === 'rubric' && rubric.categories) {
        rubric.categories.forEach(cat => cat.items.forEach(item => {
            if (item.data_source !== 'survey_time') allItems.push({ ...item, desc: item.description });
        }));
    } else if (rubric.sections) {
        rubric.sections.forEach(sec => sec.items.forEach(item => {
            allItems.push({ ...item, desc: item.question || item.criterion || item.id });
        }));
    }

    allItems.forEach(item => {
        const itemGroups = groupNames.map(name => groupMap[name].map(r => getItemPass(r, item.id)));
        const itemKW = kruskalWallisTest(itemGroups);
        const passRates = itemGroups.map(g => g.length > 0 ? computeMean(g) : 0);
        const maxDiff = Math.max(...passRates) - Math.min(...passRates);

        if (itemKW.p < 0.10 || maxDiff > 0.3) {
            difItems.push({ id: item.id, description: item.desc, passRates, pValue: itemKW.p, maxDiff });
        }
    });

    difItems.sort((a, b) => a.pValue - b.pValue);

    if (difItems.length > 0) {
        const headerRow = `<tr><th>Item</th><th>Description</th>${groupNames.map(n => `<th>${escapeHtml(n).substring(0, 20)}</th>`).join('')}<th>p-value</th></tr>`;
        const dataRows = difItems.slice(0, 15).map(item => {
            const pDisplay = item.pValue < 0.001 ? '< 0.001' : item.pValue.toFixed(3);
            const cells = item.passRates.map(rate => {
                const pct = (rate * 100).toFixed(0);
                const cls = rate > 0.7 ? 'high' : rate < 0.3 ? 'low' : 'medium';
                return `<td class="rate-cell ${cls}">${pct}%</td>`;
            }).join('');
            const rowClass = item.pValue < 0.05 ? 'significant' : '';
            return `<tr class="${rowClass}"><td class="item-id">${escapeHtml(item.id)}</td><td>${escapeHtml(item.description.substring(0, 40))}...</td>${cells}<td>${pDisplay}</td></tr>`;
        }).join('');

        difHtml += `<table class="dif-table"><thead>${headerRow}</thead><tbody>${dataRows}</tbody></table>`;
        if (difItems.length > 15) difHtml += `<p class="more-items">Showing top 15 of ${difItems.length} items with potential DIF</p>`;
    } else {
        difHtml += '<p class="no-students">No items with significant differential functioning detected.</p>';
    }

    difContainer.innerHTML = difHtml;
}

// ============ Global Search ============

function performGlobalSearch(query) {
    globalSearchQuery = query.toLowerCase().trim();
    if (!globalSearchQuery || globalSearchQuery.length < 2) {
        filteredResults = null;
        document.getElementById('global-search-count').textContent = '';
        renderSubmissionsTable();
        return;
    }

    filteredResults = data.submissions.filter(result => {
        const uidMatch = (result.uid || '').toLowerCase().includes(globalSearchQuery);
        const scenarioMatch = (result.scenario || '').toLowerCase().includes(globalSearchQuery);
        const profileMatch = (result.profile_id || '').toLowerCase().includes(globalSearchQuery);
        return uidMatch || scenarioMatch || profileMatch;
    });

    document.getElementById('global-search-count').textContent =
        `${filteredResults.length} of ${data.submissions.length} submissions`;
    renderSubmissionsTable();
}

function clearGlobalSearch() {
    document.getElementById('global-search-input').value = '';
    globalSearchQuery = '';
    filteredResults = null;
    document.getElementById('global-search-count').textContent = '';
    renderSubmissionsTable();
}

// ============ Navigation ============

function closeDetail() {
    document.getElementById('detail-view').classList.add('hidden');
    // Remove any lingering profile cards
    document.querySelectorAll('.profile-card').forEach(c => c.remove());
    clearSearch();
}

async function nextDetail() {
    if (currentResultIndex < sortedResults.length - 1) {
        await showDetailFromSorted(currentResultIndex + 1);
    }
}

async function prevDetail() {
    if (currentResultIndex > 0) {
        await showDetailFromSorted(currentResultIndex - 1);
    }
}

function showDetailFromOriginal(originalIndex) {
    if (filteredResults !== null) clearGlobalSearch();
    closeGlobalStats();
    switchView('submissions');
    const sortedIndex = sortedResults.findIndex(r => r.originalIndex === originalIndex);
    if (sortedIndex !== -1) showDetailFromSorted(sortedIndex);
}

function closeGlobalStats() {
    document.getElementById('global-stats').classList.add('hidden');
}

// ============ Event Listeners ============

document.getElementById('close-detail').addEventListener('click', closeDetail);
document.getElementById('prev-detail').addEventListener('click', prevDetail);
document.getElementById('next-detail').addEventListener('click', nextDetail);

document.getElementById('transcript-search').addEventListener('input', (e) => performSearch(e.target.value));
document.getElementById('transcript-search').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); e.shiftKey ? prevMatch() : nextMatch(); }
    if (e.key === 'Escape') clearSearch();
});

document.getElementById('search-next').addEventListener('click', nextMatch);
document.getElementById('search-prev').addEventListener('click', prevMatch);
document.getElementById('search-clear').addEventListener('click', clearSearch);

document.getElementById('global-search-input').addEventListener('input', (e) => performGlobalSearch(e.target.value));
document.getElementById('global-search-input').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') clearGlobalSearch();
});
document.getElementById('global-search-clear').addEventListener('click', clearGlobalSearch);

document.getElementById('close-global-stats').addEventListener('click', closeGlobalStats);

document.getElementById('psychometrics-scenario-filter').addEventListener('change', () => renderPsychometricsOverview());
document.getElementById('psychometrics-scale-filter').addEventListener('change', (e) => {
    selectedPsychometricsScale = e.target.value;
    renderPsychometricsOverview();
});

document.getElementById('comparisons-scale-filter').addEventListener('change', (e) => {
    selectedComparisonsScale = e.target.value;
    renderComparisonsOverview();
});
document.getElementById('comparisons-dimension-filter').addEventListener('change', (e) => {
    selectedComparisonsDimension = e.target.value;
    renderComparisonsOverview();
});

// Student row clicks in global stats
document.getElementById('global-stats-content').addEventListener('click', (e) => {
    const row = e.target.closest('.student-row');
    if (row && row.dataset.originalIndex !== undefined) {
        showDetailFromOriginal(parseInt(row.dataset.originalIndex, 10));
    }
});

// Load data on page load
document.addEventListener('DOMContentLoaded', loadData);
