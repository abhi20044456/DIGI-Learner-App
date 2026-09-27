(() => {
  const state = {
    user: null, csrf: '', page: 'home', authMode: 'login', returnPage: 'home', recoveryQuestions: [],
    courses: [], myCourses: [], payments: [], selectedCourse: null, courseDetail: null,
    adminTab: 'overview', adminOverview: null, adminCourses: [], adminPayments: [], adminUsers: [],
    adminSettings: {}, adminTopics: [], topicsCourse: null, paymentSettings: {}, adminPaymentFilter: 'all', userSearch: '',
    adminCompletions: [], adminQuizzes: [], adminQuizEditor: null, adminQuizQuestions: [],
    courseTab: 'topics', courseQuiz: null, quizResult: null, userDashboard: null, securityQuestionCount: 0,
    paymentCourse: null, paymentAcknowledged: false, rejectingPaymentId: null, search: '', busy: false,
  };

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
  const escapeHtml = (value = '') => String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const safeUrl = (value = '') => {
    const url = String(value || '').trim();
    if (!url) return '';
    try { const parsed = new URL(url, window.location.origin); return ['https:', 'http:'].includes(parsed.protocol) ? parsed.href : ''; }
    catch (_) { return ''; }
  };
  const money = (value) => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(Number(value || 0));
  const dateText = (value) => {
    if (!value) return '—';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? escapeHtml(value) : date.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
  };
  const pct = (done, total) => total ? Math.min(100, Math.round((Number(done || 0) / Number(total)) * 100)) : 0;

  function toast(message, type = 'success') {
    const root = $('#toast-root');
    const item = document.createElement('div');
    item.className = `toast${type === 'error' ? ' error' : ''}`;
    item.textContent = message;
    root.append(item);
    window.setTimeout(() => item.remove(), 4200);
  }

  async function api(path, options = {}) {
    const method = String(options.method || 'GET').toUpperCase();
    const headers = new Headers(options.headers || {});
    const init = { method, credentials: 'same-origin', headers };
    if (options.body instanceof FormData) {
      init.body = options.body;
    } else if (options.body !== undefined) {
      headers.set('Content-Type', 'application/json');
      init.body = JSON.stringify(options.body);
    }
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) headers.set('X-CSRF-Token', state.csrf);
    const response = await fetch(path, init);
    const contentType = response.headers.get('content-type') || '';
    const data = contentType.includes('application/json') ? await response.json() : null;
    if (data?.csrf_token) state.csrf = data.csrf_token;
    if (response.status === 403 && !options._retried && /session expired/i.test(data?.error || '')) {
      const sessionResponse = await fetch('/api/session', { credentials: 'same-origin' });
      const sessionData = await sessionResponse.json();
      state.csrf = sessionData.csrf_token || state.csrf;
      state.user = sessionData.user;
      return api(path, { ...options, _retried: true });
    }
    if (!response.ok) { const error = new Error(data?.error || `Request failed (${response.status}).`); error.status = response.status; throw error; }
    return data;
  }

  function showFormError(form, message) {
    let alert = $('.form-alert', form);
    if (!alert) { alert = document.createElement('div'); alert.className = 'form-alert'; form.prepend(alert); }
    alert.textContent = message;
    alert.setAttribute('role', 'alert');
  }

  function uploadExcelWithProgress(file) {
    return new Promise((resolve, reject) => {
      const upload = (retried = false) => {
        const xhr = new XMLHttpRequest();
        const progress = $('#upload-progress');
        const bar = $('#upload-progress-bar');
        const label = $('#upload-progress-label');
        progress.hidden = false;
        bar.style.width = '0%';
        label.textContent = 'Starting upload…';
        xhr.open('POST', '/api/admin/import');
        xhr.setRequestHeader('X-CSRF-Token', state.csrf);
        xhr.upload.addEventListener('progress', (event) => {
          if (event.lengthComputable) {
            const percent = Math.round((event.loaded / event.total) * 100);
            bar.style.width = `${percent}%`;
            label.textContent = percent < 100 ? `Uploading workbook · ${percent}%` : 'Upload complete · processing rows…';
          }
        });
        xhr.onerror = () => reject(new Error('Upload interrupted. Check your connection and try again.'));
        xhr.onload = async () => {
          let data = {};
          try { data = JSON.parse(xhr.responseText || '{}'); } catch (_) { data = {}; }
          if (xhr.status === 403 && !retried && /session expired/i.test(data.error || '')) {
            try { await refreshSession(); upload(true); } catch (error) { reject(error); }
            return;
          }
          if (xhr.status < 200 || xhr.status >= 300) { reject(new Error(data.error || `Upload failed (${xhr.status}).`)); return; }
          bar.style.width = '100%';
          label.textContent = `Import complete · ${data.processed} row(s) updated, ${data.failed} failed`;
          resolve(data);
        };
        const body = new FormData();
        body.append('file', file);
        xhr.send(body);
      };
      upload();
    });
  }

  async function refreshSession() {
    const result = await api('/api/session');
    state.user = result.user;
    state.csrf = result.csrf_token || state.csrf;
  }

  function button(label, action, kind = 'primary', extra = '') {
    return `<button type="button" class="btn btn-${kind}${extra ? ` ${extra}` : ''}" data-action="${escapeHtml(action)}">${label}</button>`;
  }

  function headerHtml() {
    const user = state.user;
    const links = [
      ['home', 'Courses'],
      ...(user ? [['learning', 'My learning'], ['payments', 'Payments']] : []),
      ...(user?.role === 'admin' ? [['admin', 'Admin']] : []),
    ];
    return `<div class="nav-inner">
      <button class="mobile-menu" type="button" data-action="toggle-menu" aria-label="Open navigation">☰</button>
      <a class="brand" href="#" data-action="go-home"><span class="brand-mark"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v17H6.5A2.5 2.5 0 0 1 4 17.5z"/><path d="M4 17.5A2.5 2.5 0 0 1 6.5 15H20M8 7h8M8 10h6"/></svg></span>Digi Learner</a>
      <nav class="nav-links" id="nav-links">${links.map(([page, label]) => `<button class="nav-link${state.page === page || (page === 'admin' && state.page === 'admin-topics') ? ' active' : ''}" data-page="${page}">${label}</button>`).join('')}</nav>
      <div class="nav-actions">${user ? `<span class="nav-user">Hi, ${escapeHtml(user.name.split(' ')[0])}</span><button class="btn btn-secondary btn-small" data-action="logout">Sign out</button>` : `<button class="btn btn-quiet btn-small" data-action="open-login">Sign in</button><button class="btn btn-primary btn-small" data-action="open-register">Create account</button>`}</div>
    </div>`;
  }

  function courseCard(course, enrolled = false) {
    const image = safeUrl(course.image_url);
    const done = Number(course.completed_count || 0);
    const total = Number(course.topic_count || 0);
    const progress = pct(done, total);
    return `<article class="course-card">
      <div class="course-cover">${image ? `<img src="${escapeHtml(image)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : `<span class="cover-placeholder"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v17H6.5A2.5 2.5 0 0 1 4 17.5z"/><path d="M4 17.5A2.5 2.5 0 0 1 6.5 15H20"/><path d="m10 8 4 2.5-4 2.5z"/></svg></span>`}</div>
      <div class="course-body"><span class="course-code">${escapeHtml(course.code)}</span><h3>${escapeHtml(course.title)}</h3>
        <p>${escapeHtml(course.description || 'A practical course with structured topics and guided learning.')}</p>
        <div class="course-meta"><span>${Number(course.topic_count || 0)} topics</span><span class="price">${course.is_paid ? money(course.price) : 'Free'}</span></div>
        ${enrolled ? `<div class="progress-track"><div class="progress-fill" style="width:${progress}%"></div></div><div class="progress-label">${done} of ${total} topics complete · ${progress}%</div>
          ${course.completion_status === 'pending' ? '<div class="course-status-line"><span class="pill pill-amber">Completion review pending</span></div>' : ''}
          ${course.completion_status === 'approved' && !course.certificate_code ? '<div class="course-status-line"><span class="pill pill-green">Ready for final quiz · pass 90%</span></div>' : ''}
          ${course.certificate_code ? `<a class="btn btn-secondary btn-block certificate-download" href="/api/certificates/${escapeHtml(course.certificate_code)}/download">Download certificate · PDF</a>` : ''}` : ''}
        <button class="btn btn-secondary btn-block" data-action="open-course" data-id="${course.id}">${enrolled ? 'Continue learning' : 'View course'}</button>
      </div>
    </article>`;
  }

  function homeHtml() {
    const cards = state.courses.map((course) => courseCard(course, false)).join('');
    return `<section class="hero"><div><div class="eyebrow">Your next skill starts here</div><h1>Make learning part of your everyday.</h1><p>Explore practical courses, learn one topic at a time, and keep track of how far you have come.</p>${state.user ? button('Go to my learning', 'go-learning') : button('Create your free account', 'open-register')}</div>
      <div class="hero-art" aria-hidden="true"><div class="orbit"><div class="book-tile"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v17H6.5A2.5 2.5 0 0 1 4 17.5z"/><path d="M4 17.5A2.5 2.5 0 0 1 6.5 15H20M8 7h8M8 10h6"/></svg></div></div><span class="floating-badge badge-top">Learn at your pace</span><span class="floating-badge badge-bottom">Progress that adds up</span></div></section>
      <div class="section-heading"><div><div class="eyebrow">Start exploring</div><h2>Popular courses</h2><p>Choose a course and begin with the first topic.</p></div><label class="search-bar"><span class="search-icon">⌕</span><input id="course-search" type="search" value="${escapeHtml(state.search)}" placeholder="Search courses…" autocomplete="off"></label></div>
      ${cards ? `<div class="course-grid">${cards}</div>` : `<div class="empty-state"><div class="empty-icon">⌕</div><h3>No courses found</h3><p>Try a different search, or check back when new courses are published.</p></div>`}`;
  }

  function recoveryAnswerFields() {
    return [1, 2, 3].map((number) => `<div class="field"><label for="recovery-${number}-key">Recovery question ${number}</label><select id="recovery-${number}-key" name="recovery_${number}_key" required><option value="">Choose a question</option>${state.recoveryQuestions.map((question) => `<option value="${escapeHtml(question.key)}">${escapeHtml(question.label)}</option>`).join('')}</select><input name="recovery_${number}_answer" required minlength="2" maxlength="200" autocomplete="off" placeholder="Your private answer" aria-label="Answer to recovery question ${number}"></div>`).join('');
  }

  function passwordField(id, name, label, autocomplete, minLength = false) {
    return `<div class="field"><label for="${id}">${label}</label><div class="password-control"><input id="${id}" name="${name}" type="password" ${minLength ? 'minlength="8"' : ''} autocomplete="${autocomplete}" autocapitalize="none" autocorrect="off" spellcheck="false" required placeholder="${minLength ? 'At least 8 characters' : ''}"><button class="password-toggle" type="button" data-action="toggle-password" data-target="${id}" aria-pressed="false">Show</button></div>${minLength ? '<span class="field-help">Use at least 8 characters. Passwords keep their spaces.</span>' : ''}</div>`;
  }

  function authHtml() {
    const register = state.authMode === 'register';
    const resetting = state.authMode === 'reset';
    if (resetting) return `<div class="auth-wrap"><section class="auth-promo"><div class="eyebrow">Account recovery</div><h1>Reset your password securely.</h1><p>Enter the email and the three recovery answers you saved when you created your account. We never store the answers in readable form.</p></section><section class="auth-card"><h2>Reset password</h2><p>Choose the same three questions and enter their answers.</p><form data-form="auth"><div class="field"><label for="auth-email">Account email</label><input id="auth-email" name="email" type="email" required autocomplete="email"></div>${recoveryAnswerFields()}${passwordField('new-password','new_password','New password','new-password',true)}<button class="btn btn-primary btn-block" type="submit">Reset password</button></form><p style="margin-top:18px;font-size:13px"><button class="link-button" data-action="open-login">Back to sign in</button></p></section></div>`;
    return `<div class="auth-wrap"><section class="auth-promo"><div class="eyebrow">A good place to begin</div><h1>${register ? 'Build a learning habit that lasts.' : 'Welcome back to your learning space.'}</h1><p>Learn practical skills through organized courses and pick up where you left off whenever you return.</p><div class="auth-list"><div><span class="check-dot">✓</span>Structured courses and bite-sized topics</div><div><span class="check-dot">✓</span>Track your progress as you go</div><div><span class="check-dot">✓</span>Access your approved courses anytime</div></div></section>
      <section class="auth-card"><h2>${register ? 'Create your account' : 'Sign in'}</h2><p>${register ? 'Join Digi Learner and start exploring courses.' : 'Enter your account details to continue.'}</p>
        <form data-form="auth">${register ? `<div class="field"><label for="auth-name">Full name</label><input id="auth-name" name="name" autocomplete="name" required minlength="2" maxlength="100" placeholder="Your name"></div>` : ''}
          <div class="field"><label for="auth-email">Email address</label><input id="auth-email" name="email" type="email" autocomplete="email" required placeholder="you@example.com"></div>
          ${passwordField('auth-password','password','Password',register ? 'new-password' : 'current-password',register)}
          ${register ? `<div class="recovery-box"><h3>Set up password recovery</h3><p>Choose three different questions. Answers are private and stored as one-way hashes; avoid facts people can find online.</p>${recoveryAnswerFields()}</div>` : ''}
          <button class="btn btn-primary btn-block" type="submit">${register ? 'Create account' : 'Sign in'}</button></form>
        <p class="mb-0" style="margin-top:18px;font-size:13px">${register ? 'Already have an account?' : 'New to Digi Learner?'} <button type="button" class="link-button" data-action="toggle-auth">${register ? 'Sign in' : 'Create an account'}</button>${!register ? ` · <button type="button" class="link-button" data-action="forgot-password">Forgot password?</button>` : ''}</p>
      </section></div>`;
  }

  function learningHtml() {
    const cards = state.myCourses.map((course) => courseCard(course, true)).join('');
    const s = state.userDashboard?.summary || {};
    const upcoming = Number(s.pending_payments || 0);
    return `<div class="page-heading"><div><div class="eyebrow">Your dashboard</div><h1>My learning</h1><p>Pick up where you left off and keep moving forward.</p></div></div>
      <div class="stats-grid learner-stats">${[['Courses',s.enrolled_courses,'Enrolled'],['Topics',`${s.completed_topics || 0} / ${s.available_topics || 0}`,'Completed'],['Awaiting review',s.pending_completions,'Course completion'],['Certificates',s.certificates,'Earned']].map(([label,value,note]) => `<div class="stat-card"><div class="stat-label">${label}</div><div class="stat-value">${value ?? 0}</div><div class="stat-note">${note}</div></div>`).join('')}</div>
      ${Number(state.userDashboard?.recovery_question_count || 0) < 3 ? `<div class="callout warning" style="margin-bottom:18px">Set up three account recovery questions so you can reset your password later. ${button('Set up now','open-security','secondary','btn-small')}</div>` : ''}
      ${upcoming ? `<div class="callout" style="margin-bottom:18px">You have ${upcoming} payment${upcoming === 1 ? '' : 's'} waiting for review. Check the <button class="link-button" data-page="payments">payment status page</button> for updates.</div>` : ''}
      ${cards ? `<div class="course-grid">${cards}</div>` : `<div class="empty-state"><div class="empty-icon">▣</div><h3>Your courses will appear here</h3><p>Enroll in a free course or submit a payment request for a paid course to start learning.</p>${button('Browse courses', 'go-home', 'primary')}</div>`}`;
  }

  function securityHtml() {
    return `<div class="page-heading"><div><div class="eyebrow">Account settings</div><h1>Security and recovery</h1><p>Keep your sign-in details current and add a recovery path for later.</p></div>${button('Back to dashboard','go-learning','secondary')}</div>
      <div class="security-grid"><section class="panel"><h2>Recovery questions</h2><p>Choose three different questions. Answers are stored as one-way hashes. Avoid answers that someone could find on social media.</p><form data-form="security-questions"><div class="form-grid recovery-grid">${recoveryAnswerFields()}</div><button class="btn btn-primary" type="submit">Save recovery questions</button></form></section>
      <section class="panel"><h2>Change password</h2><p>Changing your password signs out other active sessions.</p><form data-form="change-password">${passwordField('current-password','current_password','Current password','current-password')}${passwordField('new-password','new_password','New password','new-password',true)}<button class="btn btn-primary" type="submit">Update password</button></form></section></div>`;
  }

  function paymentsHtml() {
    return `<div class="page-heading"><div><div class="eyebrow">Orders and access</div><h1>Payment status</h1><p>Track your course payment requests. Access is added after admin verification.</p></div>${button('Browse courses', 'go-home', 'secondary')}</div>
      ${state.payments.length ? `<div class="table-wrap"><table><thead><tr><th>Course</th><th>UTR / reference</th><th>Amount</th><th>Submitted</th><th>Status</th><th>Admin note</th></tr></thead><tbody>${state.payments.map((p) => `<tr><td><strong>${escapeHtml(p.course_title)}</strong><br><span class="muted">${escapeHtml(p.course_code)}</span></td><td>${escapeHtml(p.utr)}</td><td>${money(p.amount)}</td><td>${dateText(p.created_at)}</td><td>${statusPill(p.status)}</td><td>${escapeHtml(p.admin_note || '—')}</td></tr>`).join('')}</tbody></table></div>` : `<div class="empty-state"><div class="empty-icon">₹</div><h3>No payment requests yet</h3><p>When you submit a course payment reference, its review status will show here.</p>${button('Explore courses', 'go-home')}</div>`}`;
  }

  function statusPill(status) {
    const cls = status === 'approved' ? 'pill-green' : status === 'rejected' ? 'pill-red' : 'pill-amber';
    return `<span class="pill ${cls}">${escapeHtml(status[0].toUpperCase() + status.slice(1))}</span>`;
  }

  function youtubeId(value) {
    const url = safeUrl(value);
    if (!url) return '';
    try {
      const parsed = new URL(url);
      const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
      if (host === 'youtu.be') return parsed.pathname.split('/').filter(Boolean)[0] || '';
      if (['youtube.com', 'm.youtube.com', 'youtube-nocookie.com'].includes(host)) {
        if (parsed.pathname === '/watch') return parsed.searchParams.get('v') || '';
        const parts = parsed.pathname.split('/').filter(Boolean);
        if (['embed', 'shorts', 'live'].includes(parts[0])) return parts[1] || '';
      }
    } catch (_) { return ''; }
    return '';
  }

  function sourcePanel(course) {
    const sources = [];
    if (course.course_video_url) sources.push({ title: `${course.title} · course introduction`, url: course.course_video_url });
    for (const topic of course.topics || []) {
      if (topic.video_url) sources.push({ title: `${topic.title} · video`, url: topic.video_url });
      if (topic.resource_url) sources.push({ title: `${topic.title} · source material`, url: topic.resource_url });
    }
    const unique = [...new Map(sources.filter((item) => safeUrl(item.url)).map((item) => [safeUrl(item.url), item])).values()];
    if (!unique.length) return `<div class="empty-state"><div class="empty-icon">↗</div><h3>No sources added yet</h3><p>Your instructor has not added videos or resource links for this course.</p></div>`;
    return `<div class="source-grid">${unique.map((source) => { const url = safeUrl(source.url); const id = youtubeId(url); return `<article class="source-card"><h3>${escapeHtml(source.title)}</h3>${id ? `<div class="video-frame"><iframe src="https://www.youtube-nocookie.com/embed/${encodeURIComponent(id)}" title="${escapeHtml(source.title)}" loading="lazy" referrerpolicy="strict-origin-when-cross-origin" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowfullscreen></iframe></div><a class="source-open-link" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">Open on YouTube ↗</a>` : `<div class="source-link-card"><span class="source-icon">↗</span><div><p>${escapeHtml(url)}</p><a class="btn btn-secondary btn-small" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">Open source</a></div></div>`}</article>`; }).join('')}</div>`;
  }

  function certificateLines(value, limit = 48) {
    const words = String(value || '').trim().split(/\s+/).filter(Boolean);
    const lines = [''];
    for (const word of words) {
      const last = lines.length - 1;
      if (lines[last] && `${lines[last]} ${word}`.length > limit && lines.length < 2) lines.push(word);
      else lines[last] = lines[last] ? `${lines[last]} ${word}` : word;
    }
    if (lines.length === 1 && lines[0].length > limit) lines[0] = `${lines[0].slice(0, limit - 1)}…`;
    else if (lines.length === 2 && lines[1].length > limit) lines[1] = `${lines[1].slice(0, limit - 1)}…`;
    return lines;
  }

  function certificateSvgMarkup(course, certificate, result) {
    const name = certificateLines(state.user?.name || 'Learner', 43);
    const title = certificateLines(course.title || 'Course', 54);
    const score = Number(result?.score ?? certificate?.score ?? 0).toFixed(0);
    const issuedAt = certificate?.issued_at || result?.issued_at || new Date().toISOString();
    const issuedDate = new Date(issuedAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });
    const code = escapeHtml(certificate?.certificate_code || '');
    const verifyUrl = escapeHtml(`${window.location.origin}/verify/${certificate?.certificate_code || ''}`);
    const textLines = (lines, y, size, color, weight = 500) => lines.map((line, index) => `<text x="600" y="${y + index * (size + 12)}" text-anchor="middle" font-family="Georgia, 'Times New Roman', serif" font-size="${size}" font-weight="${weight}" fill="${color}">${escapeHtml(line)}</text>`).join('');
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 850" role="img" aria-label="Digi Learner certificate awarded to ${escapeHtml(state.user?.name || 'Learner')}">
      <defs><linearGradient id="paper" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#f4f7fc"/></linearGradient><linearGradient id="gold" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#f4d993"/><stop offset="1" stop-color="#bd8b35"/></linearGradient></defs>
      <rect width="1200" height="850" fill="#eef2f8"/><rect x="20" y="20" width="1160" height="810" rx="18" fill="url(#paper)" stroke="#2d4f83" stroke-width="4"/><rect x="35" y="35" width="1130" height="780" rx="12" fill="none" stroke="url(#gold)" stroke-width="2"/><path d="M70 78H1130" stroke="#3869e8" stroke-width="5"/>
      <g transform="translate(565 92)"><rect width="70" height="70" rx="18" fill="#3869e8"/><g fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M15 22c10 0 16 3 20 7v29c-4-4-10-7-20-7z"/><path d="M55 22c-10 0-16 3-20 7v29c4-4 10-7 20-7z"/><path d="M35 29v29"/></g></g>
      <text x="600" y="204" text-anchor="middle" font-family="Arial,sans-serif" font-size="26" font-weight="800" letter-spacing="5" fill="#172c4d">DIGI LEARNER</text><text x="600" y="239" text-anchor="middle" font-family="Arial,sans-serif" font-size="14" letter-spacing="3" fill="#71809a">CERTIFICATE OF COURSE COMPLETION</text>
      <path d="M430 277H770" stroke="#d6b46c" stroke-width="2"/><circle cx="600" cy="277" r="5" fill="#d6b46c"/>
      <text x="600" y="333" text-anchor="middle" font-family="Arial,sans-serif" font-size="17" letter-spacing="1" fill="#65748a">THIS CERTIFICATE IS PROUDLY PRESENTED TO</text>
      ${textLines(name, 404, 42, '#315fc9', 700)}
      <text x="600" y="514" text-anchor="middle" font-family="Arial,sans-serif" font-size="16" letter-spacing="1" fill="#65748a">FOR SUCCESSFULLY COMPLETING</text>
      ${textLines(title, 571, 31, '#172c4d', 700)}
      <text x="600" y="671" text-anchor="middle" font-family="Arial,sans-serif" font-size="17" fill="#53647c">and passing the final course assessment with a score of <tspan font-weight="700" fill="#18875a">${score}%</tspan></text>
      <g transform="translate(1014 639)"><circle r="56" fill="#fff9e9" stroke="url(#gold)" stroke-width="4"/><circle r="46" fill="none" stroke="#d7b76e" stroke-width="1.5" stroke-dasharray="3 4"/><text y="-5" text-anchor="middle" font-family="Arial,sans-serif" font-size="12" font-weight="700" letter-spacing="1.5" fill="#95702b">ACHIEVED</text><text y="22" text-anchor="middle" font-family="Georgia,serif" font-size="21" font-weight="700" fill="#315fc9">${score}%</text></g>
      <path d="M130 739H1070" stroke="#d9e0eb" stroke-width="1"/><text x="130" y="779" font-family="Arial,sans-serif" font-size="14" fill="#65748a">Issued ${escapeHtml(issuedDate)}</text><text x="1070" y="779" text-anchor="end" font-family="Arial,sans-serif" font-size="13" fill="#65748a">CERTIFICATE ID · ${code}</text><text x="600" y="805" text-anchor="middle" font-family="Arial,sans-serif" font-size="10" fill="#65748a">Verify online · ${verifyUrl}</text>
    </svg>`;
  }

  async function downloadCertificateImage(course, certificate, result) {
    const svgBlob = new Blob([certificateSvgMarkup(course, certificate, result)], { type: 'image/svg+xml;charset=utf-8' });
    const svgUrl = URL.createObjectURL(svgBlob);
    const image = new Image();
    try {
      await new Promise((resolve, reject) => { image.onload = resolve; image.onerror = reject; image.src = svgUrl; });
      const canvas = document.createElement('canvas');
      canvas.width = 2400; canvas.height = 1700;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Image export is unavailable in this browser.');
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      const png = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
      if (!png) throw new Error('The certificate image could not be created. Try downloading the PDF.');
      const pngUrl = URL.createObjectURL(png);
      const link = document.createElement('a');
      link.href = pngUrl;
      link.download = `Digi-Learner-Certificate-${String(certificate.certificate_code || 'award').slice(0, 8)}.png`;
      document.body.append(link); link.click(); link.remove();
      window.setTimeout(() => URL.revokeObjectURL(pngUrl), 10000);
    } finally { URL.revokeObjectURL(svgUrl); }
  }

  function quizPanelHtml(course) {
    if (course.completion_status !== 'approved') return '';
    if (!state.courseQuiz) return `<div class="callout" style="margin-top:20px">Course completion is approved. The final quiz will appear here when the admin publishes it.</div>`;
    const quiz = state.courseQuiz;
    const certificate = quiz.certificate || (state.quizResult?.certificate_code ? { certificate_code: state.quizResult.certificate_code, issued_at: state.quizResult.issued_at, score: state.quizResult.score } : null);
    if (certificate) {
      const result = state.quizResult || certificate;
      const score = Number(result.score ?? certificate.score ?? 0).toFixed(0);
      const correctCount = result.correct_count ?? certificate.correct_count;
      const questionCount = result.question_count ?? certificate.question_count;
      const confetti = Array.from({ length: 24 }, (_, index) => `<i style="--x:${(index * 37) % 100}%;--delay:${(index % 8) * 90}ms;--hue:${(index * 53) % 360}"></i>`).join('');
      return `<section class="celebration-card" aria-live="polite"><div class="celebration-message"><span class="celebration-star" aria-hidden="true">★</span><div><div class="eyebrow">Quiz result · ${correctCount ?? '—'} of ${questionCount ?? '—'} correct · ${score}%</div><h2>Shabash, ${escapeHtml((state.user?.name || 'Learner').split(' ')[0])}! You earned it.</h2><p>Your hard work paid off. The course is complete and your certificate is ready.</p></div></div><div class="celebration-stage"><div class="certificate-art">${certificateSvgMarkup(course, certificate, result)}</div><div class="confetti" aria-hidden="true">${confetti}</div><div class="ribbon-layer" aria-hidden="true"><span class="ribbon-left"></span><span class="ribbon-right"></span><span class="ribbon-scissors">✂</span></div></div><div class="certificate-actions"><a class="btn btn-primary" href="/api/certificates/${escapeHtml(certificate.certificate_code)}/download">Download certificate · PDF</a><button class="btn btn-secondary" type="button" data-action="download-certificate-image">Download image · PNG</button><a class="text-link" href="/verify/${escapeHtml(certificate.certificate_code)}" target="_blank" rel="noopener noreferrer">Verify certificate</a></div><p class="certificate-caption">Official learner record · Certificate ID ${escapeHtml(certificate.certificate_code)}</p></section>`;
    }
    const result = state.quizResult;
    const resultBox = result ? `<div class="quiz-result ${result.passed ? 'passed' : 'retry'}"><strong>${result.passed ? 'Passed' : 'Good effort'} · ${Number(result.score).toFixed(0)}% · ${Number(result.correct_count)}/${Number(result.question_count)} correct</strong><span>${result.passed ? 'Your certificate is ready.' : `Keep going. You need at least ${Number(result.pass_percentage).toFixed(0)}%. Review the course and try again.`}</span></div>` : quiz.best_attempt ? `<div class="callout" style="margin-bottom:14px">Best attempt: ${Number(quiz.best_attempt.score).toFixed(0)}%. Required to pass: ${Number(quiz.quiz.pass_percentage).toFixed(0)}%.</div>` : '';
    const questions = (quiz.questions || []).map((question, index) => `<fieldset class="quiz-question"><legend><span class="topic-index">${index + 1}</span>${escapeHtml(question.prompt)}</legend><div class="quiz-options">${question.options.map((option, choice) => `<label class="quiz-option"><input type="radio" name="question_${question.id}" value="${choice}" required><span>${escapeHtml(option)}</span></label>`).join('')}</div></fieldset>`).join('');
    return `<div class="quiz-card" id="quiz-panel"><div class="admin-toolbar"><div><div class="eyebrow">Final assessment</div><h2>${escapeHtml(quiz.quiz.title)}</h2><p class="mb-0">Choose one answer for each question. Score ${Number(quiz.quiz.pass_percentage).toFixed(0)}% or more to earn your certificate.</p></div><span class="pill pill-amber">${quiz.questions.length} questions</span></div>${resultBox}<form data-form="quiz-submit"><div class="quiz-list">${questions}</div><button class="btn btn-primary" type="submit">Submit final quiz</button></form></div>`;
  }

  function courseDetailHtml() {
    const c = state.courseDetail;
    if (!c) return `<div class="loading-state"><span class="spinner"></span>Loading course…</div>`;
    const enrolled = c.is_enrolled;
    const topics = c.topics || [];
    const done = topics.filter((topic) => topic.completed).length;
    let action = '';
    if (enrolled) action = button('Start learning', 'scroll-topics');
    else if (c.payment_status === 'pending') action = '<button class="btn btn-secondary btn-block" disabled>Payment under review</button>';
    else if (!state.user) action = button('Sign in to enroll', 'open-login');
    else if (c.is_paid) action = button(`${c.payment_status === 'rejected' ? 'Resubmit payment details' : 'Buy course'} · ${money(c.price)}`, 'open-payment');
    else action = button('Enroll for free', 'enroll-free');
    const allTopicsDone = topics.length > 0 && done === topics.length;
    const completionPanel = !enrolled ? '' : c.completion_status === 'approved'
      ? `<div class="callout" style="margin-top:18px">Your course completion is approved. Pass the final quiz with at least 90% to receive your certificate.</div>${quizPanelHtml(c)}`
      : c.completion_status === 'pending'
        ? `<div class="callout" style="margin-top:18px">Your course completion is waiting for admin review. You can take the final quiz after approval.</div>`
        : `<div class="completion-panel"><div><strong>${allTopicsDone ? 'All topics complete' : 'Course progress'}</strong><span>${allTopicsDone ? 'Submit your work for admin review to unlock the final quiz.' : `${done} of ${topics.length} topics complete`}</span>${c.completion_status === 'rejected' && c.completion_review_note ? `<span class="inline-note">Admin note: ${escapeHtml(c.completion_review_note)}</span>` : ''}</div>${allTopicsDone ? `<button class="btn btn-primary" data-action="request-completion">${c.completion_status === 'rejected' ? 'Resubmit for approval' : 'Request completion approval'}</button>` : `<span class="pill">${pct(done, topics.length)}% complete</span>`}</div>`;
    const topicRows = topics.length ? `<div class="topic-list">${topics.map((topic, index) => {
      const searchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(`${topic.title} ${c.title}`)}`;
      return `<article class="topic-row"><span class="topic-index">${String(index + 1).padStart(2, '0')}</span><div><h4>${enrolled ? `<a class="topic-search-link" href="${searchUrl}" target="_blank" rel="noopener noreferrer">${escapeHtml(topic.title)} ↗</a>` : escapeHtml(topic.title)} ${topic.completed ? '<span class="pill pill-green">Done</span>' : ''}</h4>${enrolled ? `<p>${escapeHtml(topic.description || 'Open YouTube to choose a video for this topic.')}</p>` : ''}</div>
        ${enrolled ? `<div class="topic-actions"><a class="btn btn-secondary btn-small" href="${searchUrl}" target="_blank" rel="noopener noreferrer">Search YouTube</a>${topic.completed ? '<span class="pill pill-green">Complete</span>' : `<button class="btn btn-primary btn-small" data-action="complete-topic" data-id="${topic.id}">Mark complete</button>`}</div>` : `<span class="locked-text">🔒 Preview</span>`}</article>`;
    }).join('')}</div>` : `<div class="empty-state"><h3>Course content is being prepared</h3><p>Topics will appear here when the instructor adds them.</p></div>`;
    return `<button class="btn btn-quiet btn-small" data-action="go-home" style="margin-bottom:16px">← All courses</button>
      <div class="course-detail"><div><section class="course-detail-banner"><span class="course-code">${escapeHtml(c.code)}</span><h1>${escapeHtml(c.title)}</h1><p>${escapeHtml(c.description || 'A practical course with guided topics.')}</p></section>
        ${enrolled ? `<div class="course-tabs"><button class="course-tab${state.courseTab === 'topics' ? ' active' : ''}" data-course-tab="topics">Course topics</button><button class="course-tab${state.courseTab === 'sources' ? ' active' : ''}" data-course-tab="sources">Sources and videos</button></div>` : ''}
        ${!enrolled || state.courseTab === 'topics' ? `<section class="panel" id="topics-section"><div class="section-heading" style="margin:0 0 14px"><div><h2>${enrolled ? 'Course topics' : 'Course outline'}</h2><p>${enrolled ? `${done} of ${topics.length} topics completed · ${pct(done, topics.length)}%` : 'Preview the course outline below.'}</p></div></div>${topicRows}${completionPanel}</section>` : `<section class="panel"><div class="section-heading" style="margin:0 0 17px"><div><h2>Course sources</h2><p>Watch embedded YouTube lessons or open the instructor’s links.</p></div></div>${sourcePanel(c)}</section>`}
        </div><aside class="detail-card"><h3>Course overview</h3><div class="summary-line"><span>Format</span><strong>Self-paced</strong></div><div class="summary-line"><span>Topics</span><strong>${topics.length}</strong></div><div class="summary-line"><span>Price</span><strong>${c.is_paid ? money(c.price) : 'Free'}</strong></div>${enrolled ? `<div class="progress-track" style="margin-top:17px"><div class="progress-fill" style="width:${pct(done, topics.length)}%"></div></div><div class="progress-label">${pct(done, topics.length)}% complete</div>` : ''}
          <div style="margin-top:17px">${action}</div>
          ${!enrolled && c.payment_status === 'pending' ? `<div class="callout" style="margin-top:15px">Your payment is waiting for review. Check <button class="link-button" data-page="payments">Payment status</button>.</div>` : ''}
          ${!enrolled && c.payment_status === 'rejected' ? `<div class="callout warning" style="margin-top:15px">Your last request was rejected. Read its reason on the Payment status page before resubmitting.</div>` : ''}
          ${!enrolled && c.is_paid && !c.payment_status ? `<p style="font-size:12px;margin:14px 0 0">Course access is added after the admin verifies your UPI reference.</p>` : ''}</aside></div>`;
  }

  function adminTabs() {
    const tabs = [['overview','Overview'],['courses','Courses & topics'],['completions','Course approvals'],['quizzes','Quizzes & certificates'],['payments','Payments'],['import','Excel import'],['users','Students'],['settings','Payment settings']];
    return `<div class="admin-tabs">${tabs.map(([key,label]) => { const count = key === 'payments' ? state.adminOverview?.summary?.pending_payments : key === 'completions' ? state.adminOverview?.summary?.pending_completions : 0; return `<button class="admin-tab${state.adminTab === key ? ' active' : ''}" data-admin-tab="${key}">${label}${count ? ` · ${count}` : ''}</button>`; }).join('')}</div>`;
  }

  function overviewHtml() {
    const data = state.adminOverview;
    if (!data) return `<div class="loading-state"><span class="spinner"></span>Loading dashboard…</div>`;
    const s = data.summary;
    return `<div class="stats-grid">${[
      ['Students', s.users, 'Registered learner accounts'], ['Courses', s.courses, 'Published and draft courses'],
      ['Enrollments', s.enrollments, 'Active course enrollments'], ['Payments to review', s.pending_payments, 'Manual UPI requests'],
      ['Completions to review', s.pending_completions, 'Ready for the final quiz'], ['Quizzes passed', s.quizzes_passed, 'Assessment results'],
      ['Certificates', s.certificates_issued, 'Issued and verifiable'],
    ].map(([label,value,note]) => `<div class="stat-card"><div class="stat-label">${label}</div><div class="stat-value">${Number(value || 0).toLocaleString('en-IN')}</div><div class="stat-note">${note}</div></div>`).join('')}</div>
      <div class="panel" style="margin-bottom:20px"><div class="admin-toolbar"><div><h2>Verified revenue</h2><p class="mb-0" style="font-size:12px">Recorded approvals · last 30 days: ${money(s.revenue_30_days)}</p></div><div class="stat-value" style="margin:0">${money(s.verified_revenue)}</div></div></div>
      <div class="admin-toolbar"><h2>Course activity</h2>${button('Manage courses', 'admin-tab-courses', 'secondary', 'btn-small')}</div>
      ${data.courses.length ? `<div class="table-wrap"><table><thead><tr><th>Course</th><th>Students</th><th>Topics</th><th>Completed topic marks</th></tr></thead><tbody>${data.courses.map((c) => `<tr><td><strong>${escapeHtml(c.title)}</strong><br><span class="muted">${escapeHtml(c.code)}</span></td><td>${c.students}</td><td>${c.topics}</td><td>${c.completed_topics}</td></tr>`).join('')}</tbody></table></div>` : `<div class="empty-state"><h3>No courses yet</h3><p>Add a course to start building your catalog.</p>${button('Create a course','new-course')}</div>`}`;
  }

  function adminCompletionsHtml() {
    const rows = state.adminCompletions.map((c) => `<tr><td><input class="completion-select" type="checkbox" value="${c.enrollment_id}" aria-label="Select ${escapeHtml(c.user_name)}"></td><td><strong>${escapeHtml(c.user_name)}</strong><br><span class="muted">${escapeHtml(c.user_email)}</span></td><td><strong>${escapeHtml(c.course_title)}</strong><br><span class="muted">${escapeHtml(c.course_code)}</span></td><td>${c.completed_count}/${c.topic_count} topics · ${pct(c.completed_count,c.topic_count)}%</td><td>${dateText(c.completion_submitted_at)}</td><td><button class="btn btn-primary btn-small" data-action="approve-completion" data-id="${c.enrollment_id}">Approve</button></td></tr>`).join('');
    return `<div class="admin-toolbar"><div><h2>Course completion approvals</h2><p class="mb-0" style="font-size:12px">Review topic progress before unlocking each student's final quiz.</p></div>${rows ? button('Approve selected','bulk-approve-completions','primary','btn-small') : ''}</div>${rows ? `<div class="table-wrap"><table><thead><tr><th><input id="select-all-completions" type="checkbox" aria-label="Select all pending completions"></th><th>Student</th><th>Course</th><th>Progress</th><th>Submitted</th><th>Action</th></tr></thead><tbody>${rows}</tbody></table></div>` : `<div class="empty-state"><h3>No completion requests waiting</h3><p>Students who finish every topic can request approval here.</p></div>`}`;
  }

  function adminQuizzesHtml() {
    const rows = state.adminQuizzes.map((q) => `<tr><td><strong>${escapeHtml(q.title)}</strong><br><span class="muted">${escapeHtml(q.code)}</span></td><td>${escapeHtml(q.quiz_title)}</td><td>${q.question_count}</td><td>${Number(q.pass_percentage).toFixed(0)}%</td><td>${q.published ? '<span class="pill pill-green">Published</span>' : '<span class="pill">Draft</span>'}</td><td><button class="btn btn-secondary btn-small" data-action="manage-quiz" data-id="${q.course_id}">${q.quiz_id ? 'Edit quiz' : 'Set up quiz'}</button></td></tr>`).join('');
    return `<div class="admin-toolbar"><div><h2>Quizzes and certificates</h2><p class="mb-0" style="font-size:12px">Set a completion quiz for each course. Passing score cannot be lower than 90%.</p></div></div>${rows ? `<div class="table-wrap"><table><thead><tr><th>Course</th><th>Quiz</th><th>Questions</th><th>Pass mark</th><th>Visibility</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>` : `<div class="empty-state"><h3>Add a course first</h3><p>Every course quiz belongs to a course.</p>${button('Manage courses','admin-tab-courses','primary')}</div>`}`;
  }

  function adminQuizEditorHtml() {
    const editor = state.adminQuizEditor;
    if (!editor) return `<div class="loading-state"><span class="spinner"></span>Loading quiz…</div>`;
    const quiz = editor.quiz || {};
    const rows = state.adminQuizQuestions.map((q, index) => `<tr><td>${index + 1}</td><td><strong>${escapeHtml(q.prompt)}</strong><br>${q.options.map((option, n) => `<span class="${n === q.correct_option ? 'correct-answer' : 'muted'}">${n === q.correct_option ? '✓ ' : ''}${escapeHtml(option)}</span>`).join(' · ')}</td><td><div class="table-actions"><button class="btn btn-secondary btn-small" data-action="edit-quiz-question" data-id="${q.id}">Edit</button><button class="btn btn-danger btn-small" data-action="delete-quiz-question" data-id="${q.id}">Delete</button></div></td></tr>`).join('');
    return `<button class="btn btn-quiet btn-small" data-action="admin-tab-quizzes" style="margin-bottom:14px">← Quizzes</button><div class="page-heading"><div><div class="eyebrow">${escapeHtml(editor.course.code)}</div><h1>${escapeHtml(editor.course.title)} · final quiz</h1><p>The student sees this assessment after topic completion is approved.</p></div></div>
      <section class="panel" style="margin-bottom:18px"><form data-form="quiz-settings"><div class="form-grid"><div class="field"><label>Quiz title</label><input name="title" maxlength="200" value="${escapeHtml(quiz.title || 'Course completion quiz')}" required></div><div class="field"><label>Passing score (%)</label><input name="pass_percentage" type="number" min="90" max="100" value="${escapeHtml(quiz.pass_percentage || 90)}" required><span class="field-help">Minimum 90%, maximum 100%.</span></div></div><label class="checkbox-field"><input name="published" type="checkbox" ${quiz.published ? 'checked' : ''}> Publish this quiz to eligible students</label><button class="btn btn-primary" type="submit">Save quiz settings</button></form></section>
      <div class="admin-toolbar"><div><h2>Questions (${state.adminQuizQuestions.length})</h2><p class="mb-0" style="font-size:12px">Correct answers are kept private from students.</p></div>${button('+ Add question','new-quiz-question','primary','btn-small')}</div>${rows ? `<div class="table-wrap"><table><thead><tr><th>#</th><th>Question and answer choices</th><th>Actions</th></tr></thead><tbody>${rows}</tbody></table></div>` : `<div class="empty-state"><h3>Build the final quiz</h3><p>Add clear questions and mark one correct answer for each.</p>${button('+ Add question','new-quiz-question')}</div>`}`;
  }

  function adminCoursesHtml() {
    const rows = state.adminCourses.map((c) => `<tr><td><strong>${escapeHtml(c.title)}</strong><br><span class="muted">${escapeHtml(c.code)}</span></td><td>${c.topic_count}</td><td>${c.student_count}</td><td>${c.is_paid ? money(c.price) : 'Free'}</td><td>${c.published ? '<span class="pill pill-green">Published</span>' : '<span class="pill">Draft</span>'}</td><td><div class="table-actions"><button class="btn btn-secondary btn-small" data-action="topics-course" data-id="${c.id}">Topics</button><button class="btn btn-secondary btn-small" data-action="edit-course" data-id="${c.id}">Edit</button><button class="btn btn-danger btn-small" data-action="delete-course" data-id="${c.id}">Delete</button></div></td></tr>`).join('');
    return `<div class="admin-toolbar"><div><h2>Courses</h2><p class="mb-0" style="font-size:12px">Create courses, add lessons, and control what students can see.</p></div><div class="toolbar-actions">${button('Export CSV','', 'secondary', 'btn-small').replace('data-action=""','data-action="export-csv"')} ${button('+ Add course','new-course','primary','btn-small')}</div></div>
      ${rows ? `<div class="table-wrap"><table><thead><tr><th>Course</th><th>Topics</th><th>Students</th><th>Price</th><th>Visibility</th><th>Actions</th></tr></thead><tbody>${rows}</tbody></table></div>` : `<div class="empty-state"><h3>Your course catalog is empty</h3><p>Create a course manually or import a course workbook.</p>${button('+ Add course','new-course')}</div>`}`;
  }

  function adminPaymentsHtml() {
    const rows = state.adminPayments.map((p) => `<tr><td><strong>${escapeHtml(p.user_name)}</strong><br><span class="muted">${escapeHtml(p.user_email)}</span></td><td><strong>${escapeHtml(p.course_title)}</strong><br><span class="muted">${escapeHtml(p.course_code)}</span></td><td>${money(p.amount)}</td><td><strong>${escapeHtml(p.utr)}</strong>${p.duplicate_utr ? '<br><span class="pill pill-red">Duplicate UTR</span>' : ''}<br><span class="muted">${dateText(p.payment_date)}</span></td><td>${statusPill(p.status)}${p.admin_note ? `<br><span class="muted">${escapeHtml(p.admin_note)}</span>` : ''}</td><td>${p.status === 'pending' ? `<div class="table-actions"><button class="btn btn-primary btn-small" data-action="approve-payment" data-id="${p.id}" ${p.duplicate_utr ? 'disabled title="Duplicate UTR requires investigation"' : ''}>Approve</button><button class="btn btn-danger btn-small" data-action="reject-payment" data-id="${p.id}">Reject</button></div>` : `<span class="muted">Reviewed ${dateText(p.reviewed_at)}</span>`}</td></tr>`).join('');
    return `<div class="admin-toolbar"><div><h2>Payment requests</h2><p class="mb-0" style="font-size:12px">Verify the amount and UTR in your bank or UPI app before approving.</p></div><select class="field" style="margin:0;min-width:145px" id="payment-filter"><option value="all" ${state.adminPaymentFilter === 'all' ? 'selected' : ''}>All statuses</option><option value="pending" ${state.adminPaymentFilter === 'pending' ? 'selected' : ''}>Pending</option><option value="approved" ${state.adminPaymentFilter === 'approved' ? 'selected' : ''}>Approved</option><option value="rejected" ${state.adminPaymentFilter === 'rejected' ? 'selected' : ''}>Rejected</option></select></div>
      ${rows ? `<div class="table-wrap"><table><thead><tr><th>Student</th><th>Course</th><th>Amount</th><th>UTR / date</th><th>Status</th><th>Review</th></tr></thead><tbody>${rows}</tbody></table></div>` : `<div class="empty-state"><h3>No payments to show</h3><p>Student payment submissions will appear here for verification.</p></div>`}`;
  }

  function adminImportHtml() {
    return `<div class="page-heading"><div><div class="eyebrow">Bulk course management</div><h1>Excel import</h1><p>Use one row per topic. Existing course codes and topic titles are updated safely.</p></div><a class="btn btn-secondary" href="/api/admin/import-template.xlsx">Download template</a></div>
      <div class="panel"><form data-form="import" class="drop-zone"><div class="empty-icon">⇧</div><h3>Upload an .xlsx workbook</h3><p>Maximum 5 MB. The CourseUpload sheet is used when present; otherwise the first sheet is read.</p><div class="field" style="align-items:center"><label for="excel-file">Choose workbook</label><input id="excel-file" type="file" name="file" accept=".xlsx" required></div><button class="btn btn-primary" type="submit">Import courses and topics</button><div id="upload-progress" class="upload-progress" hidden><div class="upload-track"><div id="upload-progress-bar" class="upload-fill"></div></div><div id="upload-progress-label" class="upload-label" aria-live="polite">Preparing upload…</div></div></form><div id="import-result"></div></div>
      <div class="panel" style="margin-top:18px"><h3>Expected columns</h3><p class="mb-0" style="font-size:12px;overflow-wrap:anywhere">CourseCode, CourseTitle, CourseDescription, ImageURL, CourseVideoURL, Paid, Price, Published, TopicTitle, TopicDescription, VideoURL, ResourceURL, SortOrder</p></div>`;
  }

  function adminUsersHtml() {
    const rows = state.adminUsers.map((u) => `<tr><td><strong>${escapeHtml(u.name)}</strong></td><td>${escapeHtml(u.email)}</td><td>${u.course_count}</td><td>${dateText(u.created_at)}</td><td>${dateText(u.last_login)}</td><td>${u.active ? '<span class="pill pill-green">Active</span>' : '<span class="pill pill-red">Disabled</span>'}</td></tr>`).join('');
    return `<div class="admin-toolbar"><div><h2>Students</h2><p class="mb-0" style="font-size:12px">Accounts and learning activity at a glance.</p></div><label class="search-bar" style="width:260px"><span class="search-icon">⌕</span><input type="search" id="user-search" value="${escapeHtml(state.userSearch)}" placeholder="Find a student…"></label></div>
      ${rows ? `<div class="table-wrap"><table><thead><tr><th>Name</th><th>Email</th><th>Courses</th><th>Joined</th><th>Last sign in</th><th>Account</th></tr></thead><tbody>${rows}</tbody></table></div>` : `<div class="empty-state"><h3>No student accounts yet</h3><p>New learner registrations will appear here.</p></div>`}`;
  }

  function adminSettingsHtml() {
    const s = state.adminSettings;
    const qr = safeUrl(s.qr_image_url);
    return `<div class="page-heading"><div><div class="eyebrow">Manual UPI checkout</div><h1>Payment settings</h1><p>These details appear on the course checkout screen.</p></div></div>
      <div class="panel"><form data-form="settings"><div class="form-grid"><div class="field"><label for="upi-id">UPI ID</label><input id="upi-id" name="upi_id" value="${escapeHtml(s.upi_id || '')}" placeholder="yourname@bank"></div><div class="field"><label for="qr-image">QR image URL</label><input id="qr-image" name="qr_image_url" type="url" value="${escapeHtml(s.qr_image_url || '')}" placeholder="https://…"><span class="field-help">Use a public HTTPS image URL. Do not paste secret account credentials here.</span></div></div><div class="field"><label for="pay-instructions">Payment instructions</label><textarea id="pay-instructions" name="payment_instructions" maxlength="2000">${escapeHtml(s.payment_instructions || '')}</textarea></div>${qr ? `<img class="qr-preview" src="${escapeHtml(qr)}" alt="UPI QR code preview" referrerpolicy="no-referrer">` : ''}<div class="callout warning">The QR/payment app does not confirm a payment to this website. Always verify the UTR and amount in your bank or UPI app before approval.</div><div class="modal-actions"><button class="btn btn-primary" type="submit">Save payment settings</button></div></form></div>`;
  }

  function adminTopicsHtml() {
    const course = state.topicsCourse;
    if (!course) return `<div class="loading-state"><span class="spinner"></span>Loading topics…</div>`;
    const rows = state.adminTopics.map((t) => `<tr><td>${t.sort_order}</td><td><strong>${escapeHtml(t.title)}</strong><br><span class="muted">${escapeHtml(t.description || '')}</span></td><td>${safeUrl(t.video_url) ? '<span class="pill pill-green">Video linked</span>' : '—'}</td><td>${safeUrl(t.resource_url) ? '<span class="pill pill-green">Resource linked</span>' : '—'}</td><td><div class="table-actions"><button class="btn btn-secondary btn-small" data-action="edit-topic" data-id="${t.id}">Edit</button><button class="btn btn-danger btn-small" data-action="delete-topic" data-id="${t.id}">Delete</button></div></td></tr>`).join('');
    return `<button class="btn btn-quiet btn-small" data-action="admin-tab-courses" style="margin-bottom:14px">← Courses</button><div class="admin-toolbar"><div><div class="eyebrow">${escapeHtml(course.code)}</div><h2>${escapeHtml(course.title)} · Topics</h2><p class="mb-0" style="font-size:12px">Add and arrange lessons. Students see topics after enrolling.</p></div>${button('+ Add topic','new-topic','primary','btn-small')}</div>
      ${rows ? `<div class="table-wrap"><table><thead><tr><th>Order</th><th>Topic</th><th>Video</th><th>Resource</th><th>Actions</th></tr></thead><tbody>${rows}</tbody></table></div>` : `<div class="empty-state"><h3>No topics yet</h3><p>Add a topic now or import a workbook.</p>${button('+ Add topic','new-topic')}</div>`}`;
  }

  function pageHtml() {
    if (state.page === 'auth') return authHtml();
    if (state.page === 'home') return homeHtml();
    if (state.page === 'learning') return learningHtml();
    if (state.page === 'payments') return paymentsHtml();
    if (state.page === 'security') return securityHtml();
    if (state.page === 'course') return courseDetailHtml();
    if (state.page === 'admin') {
      let content = '';
      if (state.adminTab === 'overview') content = overviewHtml();
      else if (state.adminTab === 'courses') content = adminCoursesHtml();
      else if (state.adminTab === 'payments') content = adminPaymentsHtml();
      else if (state.adminTab === 'import') content = adminImportHtml();
      else if (state.adminTab === 'users') content = adminUsersHtml();
      else if (state.adminTab === 'settings') content = adminSettingsHtml();
      else if (state.adminTab === 'completions') content = adminCompletionsHtml();
      else if (state.adminTab === 'quizzes') content = adminQuizzesHtml();
      return `<div class="page-heading"><div><div class="eyebrow">Digi Learner management</div><h1>Admin dashboard</h1><p>Manage the learning catalog, review payment requests, and see student activity.</p></div></div>${adminTabs()}${content}`;
    }
    if (state.page === 'admin-topics') return adminTopicsHtml();
    if (state.page === 'admin-quiz') return adminQuizEditorHtml();
    return homeHtml();
  }

  function render() {
    $('#site-header').innerHTML = headerHtml();
    $('#app-main').innerHTML = pageHtml();
    $('#modal-root').innerHTML = modalHtml();
  }

  function modalShell(title, body, close = true) {
    return `<div class="modal-backdrop" data-action="backdrop-close"><section class="modal" role="dialog" aria-modal="true" aria-label="${escapeHtml(title)}"><div class="modal-head"><h2>${escapeHtml(title)}</h2>${close ? '<button class="modal-close" data-action="close-modal" aria-label="Close">×</button>' : ''}</div><div class="modal-body">${body}</div></section></div>`;
  }

  function modalHtml() {
    if (state.paymentCourse) {
      const c = state.paymentCourse;
      const s = state.paymentSettings;
      const qr = safeUrl(s.qr_image_url);
      if (!state.user) return modalShell('Sign in required', `<p>Sign in or create an account before submitting a payment request.</p><div class="modal-actions">${button('Sign in','open-login','primary')}<button class="btn btn-secondary" data-action="close-modal">Cancel</button></div>`);
      if (!state.paymentAcknowledged) return modalShell(`Buy ${c.title}`, `<div class="payment-layout"><div>${qr ? `<img class="payment-qr" src="${escapeHtml(qr)}" alt="UPI payment QR code" referrerpolicy="no-referrer">` : `<div class="payment-qr-placeholder">Admin has not added a QR image yet.<br>Check the UPI ID below.</div>`}</div><div><div class="summary-line"><span>Course</span><strong>${escapeHtml(c.title)}</strong></div><div class="summary-line"><span>Pay exactly</span><strong>${money(c.price)}</strong></div><div class="summary-line"><span>UPI ID</span><strong>${escapeHtml(s.upi_id || 'Ask the course admin')}</strong></div><p style="font-size:13px;margin:13px 0">${escapeHtml(s.payment_instructions || '')}</p></div></div><div class="callout warning" style="margin-top:17px">After paying, tap “I have made payment” and enter your UTR/reference number. Course access stays locked until the admin verifies it.</div><div class="modal-actions"><button class="btn btn-secondary" data-action="close-modal">Cancel</button><button class="btn btn-primary" data-action="payment-acknowledged">I have made payment</button></div>`);
      const today = new Date().toISOString().slice(0, 10);
      return modalShell('Submit payment details', `<p>Enter the reference shown in your UPI app. A screenshot alone is not proof of a successful transfer.</p><form data-form="payment"><div class="field"><label for="utr">UPI transaction ID / UTR</label><input id="utr" name="utr" required minlength="6" maxlength="80" autocomplete="off" placeholder="Enter UTR or reference number"></div><div class="field"><label for="payment-date">Payment date</label><input id="payment-date" name="payment_date" type="date" max="${today}" value="${today}"></div><div class="callout">Course: <strong>${escapeHtml(c.title)}</strong> · Amount: <strong>${money(c.price)}</strong></div><div class="modal-actions"><button class="btn btn-secondary" type="button" data-action="payment-back">Back</button><button class="btn btn-primary" type="submit">Submit for admin review</button></div></form>`);
    }
    if (state.rejectingPaymentId) return modalShell('Reject payment request', `<p>Give the student a clear reason so they know what to correct.</p><form data-form="reject-payment"><div class="field"><label for="reject-note">Reason</label><textarea id="reject-note" name="note" required maxlength="1000" placeholder="For example: UTR could not be found in the payment statement."></textarea></div><div class="modal-actions"><button class="btn btn-secondary" type="button" data-action="close-modal">Cancel</button><button class="btn btn-danger" type="submit">Reject payment</button></div></form>`);
    if (state.editor?.kind === 'course') {
      const c = state.editor.item || {};
      return modalShell(c.id ? 'Edit course' : 'Create course', `<form data-form="course-editor"><div class="form-grid"><div class="field"><label>Course code</label><input name="code" required maxlength="60" value="${escapeHtml(c.code || '')}" placeholder="PY-101"></div><div class="field"><label>Course title</label><input name="title" required maxlength="200" value="${escapeHtml(c.title || '')}" placeholder="Python Programming"></div></div><div class="field"><label>Description</label><textarea name="description" maxlength="5000" placeholder="What will students learn?">${escapeHtml(c.description || '')}</textarea></div><div class="form-grid"><div class="field"><label>Image URL</label><input name="image_url" type="url" value="${escapeHtml(c.image_url || '')}" placeholder="https://…"></div><div class="field"><label>Course video URL</label><input name="course_video_url" type="url" value="${escapeHtml(c.course_video_url || '')}" placeholder="https://…"></div></div><div class="form-grid"><div class="field"><label>Price (₹)</label><input name="price" type="number" min="0" step="1" value="${escapeHtml(c.price || 0)}"></div><label class="checkbox-field"><input name="is_paid" type="checkbox" ${c.is_paid ? 'checked' : ''}> Paid course</label></div><label class="checkbox-field"><input name="published" type="checkbox" ${c.published ? 'checked' : ''}> Publish course so students can see it</label><div class="modal-actions"><button class="btn btn-secondary" type="button" data-action="close-modal">Cancel</button><button class="btn btn-primary" type="submit">${c.id ? 'Save changes' : 'Create course'}</button></div></form>`);
    }
    if (state.editor?.kind === 'topic') {
      const t = state.editor.item || {};
      return modalShell(t.id ? 'Edit topic' : 'Add topic', `<form data-form="topic-editor"><div class="field"><label>Topic title</label><input name="title" required maxlength="200" value="${escapeHtml(t.title || '')}" placeholder="Getting started"></div><div class="field"><label>Description</label><textarea name="description" maxlength="5000">${escapeHtml(t.description || '')}</textarea></div><div class="form-grid"><div class="field"><label>Video URL</label><input name="video_url" type="url" value="${escapeHtml(t.video_url || '')}" placeholder="https://…"></div><div class="field"><label>Resource URL</label><input name="resource_url" type="url" value="${escapeHtml(t.resource_url || '')}" placeholder="https://…"></div></div><div class="field"><label>Sort order</label><input name="sort_order" type="number" min="1" step="1" value="${escapeHtml(t.sort_order || (state.adminTopics.length + 1))}"></div><div class="modal-actions"><button class="btn btn-secondary" type="button" data-action="close-modal">Cancel</button><button class="btn btn-primary" type="submit">${t.id ? 'Save changes' : 'Add topic'}</button></div></form>`);
    }
    if (state.editor?.kind === 'quizquestion') {
      const q = state.editor.item || {};
      const options = Array.isArray(q.options) ? q.options : [];
      const optionInputs = [0,1,2,3].map((index) => `<div class="quiz-option-editor"><label class="correct-choice"><input type="radio" name="correct_option" value="${index}" aria-label="Set answer choice ${index + 1} as the answer key" ${Number(q.correct_option || 0) === index ? 'checked' : ''} ${index < 2 ? 'required' : ''}> Answer key</label><input name="option_${index}" maxlength="500" value="${escapeHtml(options[index] || '')}" ${index < 2 ? 'required' : ''} placeholder="Answer choice ${index + 1}"></div>`).join('');
      return modalShell(q.id ? 'Edit quiz question' : 'Add quiz question', `<form data-form="quiz-question"><div class="field"><label>Question</label><textarea name="prompt" maxlength="1000" required>${escapeHtml(q.prompt || '')}</textarea></div><div class="field"><label>Answer choices</label>${optionInputs}<span class="field-help">Admin setting: mark one answer key. Learners only see the choices, never this setting.</span></div><div class="field"><label>Question order</label><input name="sort_order" type="number" min="1" value="${escapeHtml(q.sort_order || (state.adminQuizQuestions.length + 1))}"></div><div class="modal-actions"><button class="btn btn-secondary" type="button" data-action="close-modal">Cancel</button><button class="btn btn-primary" type="submit">${q.id ? 'Save question' : 'Add question'}</button></div></form>`);
    }
    return '';
  }

  async function loadCourses() {
    const result = await api(`/api/courses?q=${encodeURIComponent(state.search)}`);
    state.courses = result.courses || [];
  }

  async function loadMyLearning() {
    const dashboard = await api('/api/me/dashboard');
    state.userDashboard = dashboard;
    state.myCourses = dashboard.courses || [];
    state.payments = dashboard.payments || [];
  }

  async function loadAdminTab() {
    if (state.adminTab === 'overview') {
      state.adminOverview = await api('/api/admin/overview');
    } else if (state.adminTab === 'courses') {
      state.adminCourses = (await api('/api/admin/courses')).courses || [];
    } else if (state.adminTab === 'payments') {
      const filter = state.adminPaymentFilter || $('#payment-filter')?.value || 'all';
      state.adminPayments = (await api(`/api/admin/payments?status=${filter}`)).payments || [];
    } else if (state.adminTab === 'users') {
      const query = $('#user-search')?.value || state.userSearch || '';
      state.adminUsers = (await api(`/api/admin/users?q=${encodeURIComponent(query)}`)).users || [];
    } else if (state.adminTab === 'settings') {
      state.adminSettings = (await api('/api/admin/settings')).settings || {};
    } else if (state.adminTab === 'completions') {
      state.adminCompletions = (await api('/api/admin/completions')).completions || [];
    } else if (state.adminTab === 'quizzes') {
      state.adminQuizzes = (await api('/api/admin/quizzes')).quizzes || [];
    }
  }

  async function go(page) {
    if (['learning', 'payments', 'security'].includes(page) && !state.user) {
      state.returnPage = page;
      state.authMode = 'login';
      state.page = 'auth';
      render();
      return;
    }
    if (page === 'admin' && state.user?.role !== 'admin') {
      toast('Admin access is required.', 'error');
      return;
    }
    state.page = page;
    if (page === 'home') await loadCourses();
    if (page === 'learning' || page === 'payments') await loadMyLearning();
    if (page === 'admin') await loadAdminTab();
    render();
    $('#app-main').focus({ preventScroll: true });
  }

  async function openCourse(id) {
    state.page = 'course';
    state.courseDetail = null;
    state.courseQuiz = null;
    state.quizResult = null;
    state.courseTab = 'topics';
    render();
    try {
      const result = await api(`/api/courses/${id}`);
      state.courseDetail = result.course;
      if (state.courseDetail.has_access && state.courseDetail.completion_status === 'approved') {
        try { state.courseQuiz = await api(`/api/courses/${id}/quiz`); } catch (error) { if (![403,404].includes(error.status)) toast(error.message, 'error'); }
      }
      render();
    } catch (error) { toast(error.message, 'error'); await go('home'); }
  }

  async function openPayment() {
    if (!state.user) { state.paymentCourse = state.courseDetail; state.paymentSettings = {}; state.paymentAcknowledged = false; render(); return; }
    const [settings] = await Promise.all([api('/api/payment-settings')]);
    state.paymentCourse = state.courseDetail;
    state.paymentSettings = settings.settings || {};
    state.paymentAcknowledged = false;
    render();
  }

  function formObject(form) {
    const fd = new FormData(form);
    const data = Object.fromEntries(fd.entries());
    for (const checkbox of $$('input[type="checkbox"]', form)) data[checkbox.name] = checkbox.checked;
    return data;
  }

  function showEditor(kind, item = null) {
    state.editor = { kind, item };
    render();
  }

  async function deleteCourse(id) {
    if (!window.confirm('Delete this course if it has no student or payment history? Courses with history will be hidden from new students and their records will be kept.')) return;
    const result = await api(`/api/admin/courses/${id}`, { method: 'DELETE' });
    toast(result.archived ? 'Course hidden from students. Enrollment and payment history was kept.' : 'Course deleted.');
    state.adminCourses = (await api('/api/admin/courses')).courses || [];
    render();
  }

  async function loadTopics(courseId) {
    const result = await api(`/api/admin/courses/${courseId}/topics`);
    state.topicsCourse = result.course;
    state.adminTopics = result.topics || [];
    state.page = 'admin-topics';
    render();
  }

  async function loadAdminQuiz(courseId) {
    const result = await api(`/api/admin/courses/${courseId}/quiz`);
    state.adminQuizEditor = result;
    state.adminQuizQuestions = result.questions || [];
    state.page = 'admin-quiz';
    render();
  }

  async function act(action, element, originalEvent) {
    const id = element.dataset.id;
    if (action === 'go-home') { state.paymentCourse = null; state.editor = null; await go('home'); }
    else if (action === 'go-learning') await go('learning');
    else if (action === 'open-security') { state.page = 'security'; render(); }
    else if (action === 'open-login' || action === 'open-register') {
      if (state.paymentCourse && action === 'open-login') { state.paymentCourse = null; }
      state.authMode = action === 'open-register' ? 'register' : 'login';
      state.returnPage = state.page === 'auth' ? state.returnPage : state.page;
      state.page = 'auth'; render();
    }
    else if (action === 'forgot-password') { state.authMode = 'reset'; state.returnPage = 'home'; state.page = 'auth'; render(); }
    else if (action === 'toggle-auth') { state.authMode = state.authMode === 'register' ? 'login' : 'register'; render(); }
    else if (action === 'toggle-password') {
      const input = document.getElementById(element.dataset.target);
      if (input) {
        const showing = input.type === 'text';
        input.type = showing ? 'password' : 'text';
        element.textContent = showing ? 'Show' : 'Hide';
        element.setAttribute('aria-pressed', String(!showing));
        input.focus();
      }
    }
    else if (action === 'toggle-menu') $('#nav-links').classList.toggle('open');
    else if (action === 'logout') {
      await api('/api/logout', { method: 'POST', body: {} });
      state.user = null; state.myCourses = []; state.payments = [];
      await refreshSession(); toast('You have signed out.'); await go('home');
    }
    else if (action === 'open-course') await openCourse(id);
    else if (action === 'enroll-free') {
      if (!state.user) { state.returnPage = 'course'; state.page = 'auth'; state.authMode = 'login'; render(); return; }
      await api(`/api/courses/${state.courseDetail.id}/enroll`, { method: 'POST', body: {} });
      toast('You are enrolled. Start with the first topic.'); await openCourse(state.courseDetail.id);
    }
    else if (action === 'open-payment') await openPayment();
    else if (action === 'payment-acknowledged') { state.paymentAcknowledged = true; render(); }
    else if (action === 'payment-back') { state.paymentAcknowledged = false; render(); }
    else if (action === 'close-modal') { state.paymentCourse = null; state.editor = null; state.rejectingPaymentId = null; render(); }
    else if (action === 'backdrop-close' && element === originalEvent.target) { state.paymentCourse = null; state.editor = null; state.rejectingPaymentId = null; render(); }
    else if (action === 'scroll-topics') $('#topics-section')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    else if (action === 'complete-topic') {
      await api(`/api/topics/${id}/complete`, { method: 'POST', body: {} });
      state.userDashboard = null;
      toast('Topic complete · progress saved.'); await openCourse(state.courseDetail.id);
    }
    else if (action === 'request-completion') {
      await api(`/api/courses/${state.courseDetail.id}/completion-request`, { method: 'POST', body: {} });
      toast('Course sent for admin review. The final quiz unlocks after approval.'); await openCourse(state.courseDetail.id);
    }
    else if (action === 'retry-quiz') { state.quizResult = null; render(); $('#quiz-panel')?.scrollIntoView({ behavior: 'smooth' }); }
    else if (action === 'download-certificate-image') {
      const certificate = state.courseQuiz?.certificate;
      if (!state.courseDetail || !certificate) throw new Error('The certificate is not ready yet.');
      await downloadCertificateImage(state.courseDetail, certificate, state.quizResult);
      toast('Certificate image downloaded.');
    }
    else if (action.startsWith('admin-tab-')) {
      state.page = 'admin'; state.adminTab = action.replace('admin-tab-', ''); await loadAdminTab(); render();
    }
    else if (action === 'new-course') showEditor('course');
    else if (action === 'edit-course') showEditor('course', state.adminCourses.find((course) => String(course.id) === String(id)));
    else if (action === 'delete-course') await deleteCourse(id);
    else if (action === 'topics-course') await loadTopics(id);
    else if (action === 'manage-quiz') await loadAdminQuiz(id);
    else if (action === 'new-quiz-question') showEditor('quizquestion');
    else if (action === 'edit-quiz-question') showEditor('quizquestion', state.adminQuizQuestions.find((question) => String(question.id) === String(id)));
    else if (action === 'delete-quiz-question') {
      if (!window.confirm('Delete this quiz question? Existing quiz results and issued certificates will remain recorded.')) return;
      await api(`/api/admin/quiz-questions/${id}`, { method: 'DELETE' });
      toast('Quiz question deleted.'); await loadAdminQuiz(state.adminQuizEditor.course.id);
    }
    else if (action === 'new-topic') showEditor('topic');
    else if (action === 'edit-topic') showEditor('topic', state.adminTopics.find((topic) => String(topic.id) === String(id)));
    else if (action === 'delete-topic') {
      if (!window.confirm('Delete this topic? Student completion marks for it will also be removed.')) return;
      await api(`/api/admin/topics/${id}`, { method: 'DELETE' });
      toast('Topic deleted.'); await loadTopics(state.topicsCourse.id);
    }
    else if (action === 'approve-payment') {
      if (!window.confirm('Confirm that the amount and UTR match your bank or UPI statement? This will unlock the course.')) return;
      await api(`/api/admin/payments/${id}/decision`, { method: 'POST', body: { decision: 'approve' } });
      toast('Payment approved and course access granted.'); await loadAdminTab(); render();
    }
    else if (action === 'reject-payment') { state.rejectingPaymentId = id; render(); }
    else if (action === 'approve-completion') {
      if (!window.confirm('Approve this student’s course completion and unlock the final quiz?')) return;
      await api(`/api/admin/completions/${id}/decision`, { method: 'POST', body: { decision: 'approve' } });
      toast('Completion approved. Final quiz unlocked.'); await loadAdminTab(); render();
    }
    else if (action === 'bulk-approve-completions') {
      const enrollmentIds = $$('.completion-select:checked').map((input) => Number(input.value));
      if (!enrollmentIds.length) { toast('Select at least one completion request.', 'error'); return; }
      if (!window.confirm(`Approve ${enrollmentIds.length} completion request(s) and unlock their final quizzes?`)) return;
      const result = await api('/api/admin/completions/bulk-approve', { method: 'POST', body: { enrollment_ids: enrollmentIds } });
      toast(`${result.approved} completion request(s) approved.`); await loadAdminTab(); render();
    }
    else if (action === 'export-csv') window.location.href = '/api/admin/export.csv';
  }

  document.addEventListener('click', async (event) => {
    const courseTab = event.target.closest('[data-course-tab]');
    if (courseTab) { state.courseTab = courseTab.dataset.courseTab; render(); return; }
    const selectAll = event.target.closest('#select-all-completions');
    if (selectAll) { $$('.completion-select').forEach((box) => { box.checked = selectAll.checked; }); return; }
    const pageButton = event.target.closest('[data-page]');
    if (pageButton) { await go(pageButton.dataset.page); return; }
    const tabButton = event.target.closest('[data-admin-tab]');
    if (tabButton) { state.adminTab = tabButton.dataset.adminTab; await loadAdminTab(); render(); return; }
    const actionButton = event.target.closest('[data-action]');
    if (!actionButton) return;
    const action = actionButton.dataset.action;
    const busyActions = new Set(['open-course','open-payment','complete-topic','request-completion','approve-payment','reject-payment','approve-completion','bulk-approve-completions','delete-course','delete-topic','manage-quiz','delete-quiz-question','logout']);
    const originalLabel = actionButton.textContent;
    if (busyActions.has(action)) { actionButton.disabled = true; actionButton.setAttribute('aria-busy','true'); actionButton.textContent = 'Please wait…'; }
    try { await act(action, actionButton, event); }
    catch (error) { toast(error.message, 'error'); }
    finally { if (actionButton.isConnected && busyActions.has(action)) { actionButton.disabled = false; actionButton.removeAttribute('aria-busy'); actionButton.textContent = originalLabel; } }
  });

  document.addEventListener('submit', async (event) => {
    const form = event.target.closest('form[data-form]');
    if (!form) return;
    event.preventDefault();
    const submitButton = $('button[type="submit"]', form);
    const originalSubmitLabel = submitButton?.textContent;
    const kind = form.dataset.form;
    if (submitButton) { submitButton.disabled = true; submitButton.textContent = 'Please wait…'; }
    $('.form-alert', form)?.remove();
    try {
      if (kind === 'auth') {
        const data = formObject(form);
        if (state.authMode === 'reset') {
          await api('/api/reset-password', { method: 'POST', body: data });
          state.authMode = 'login'; state.page = 'auth'; render();
          toast('Password reset. Sign in with your new password.');
        } else {
          const endpoint = state.authMode === 'register' ? '/api/register' : '/api/login';
          const result = await api(endpoint, { method: 'POST', body: data });
          state.user = result.user;
          await refreshSession();
          toast(state.authMode === 'register' ? 'Your account is ready.' : `Welcome back, ${state.user.name.split(' ')[0]}.`);
          const destination = state.returnPage && state.returnPage !== 'auth' ? state.returnPage : 'home';
          state.returnPage = 'home';
          if (destination === 'course' && state.courseDetail) { state.page = 'course'; render(); await openCourse(state.courseDetail.id); }
          else if (destination === 'admin' && state.user.role === 'admin') { state.adminTab = 'overview'; await go('admin'); }
          else await go(destination);
        }
      } else if (kind === 'payment') {
        await api(`/api/courses/${state.paymentCourse.id}/payment-requests`, { method: 'POST', body: formObject(form) });
        const courseTitle = state.paymentCourse.title;
        state.paymentCourse = null;
        toast(`Payment request sent for ${courseTitle}.`);
        await go('payments');
      } else if (kind === 'course-editor') {
        const data = formObject(form);
        const isEdit = Boolean(state.editor?.item?.id);
        await api(isEdit ? `/api/admin/courses/${state.editor.item.id}` : '/api/admin/courses', { method: isEdit ? 'PATCH' : 'POST', body: data });
        state.editor = null;
        toast(isEdit ? 'Course updated.' : 'Course created.');
        await loadAdminTab(); render();
      } else if (kind === 'topic-editor') {
        const data = formObject(form);
        const isEdit = Boolean(state.editor?.item?.id);
        await api(isEdit ? `/api/admin/topics/${state.editor.item.id}` : `/api/admin/courses/${state.topicsCourse.id}/topics`, { method: isEdit ? 'PATCH' : 'POST', body: data });
        state.editor = null;
        toast(isEdit ? 'Topic updated.' : 'Topic added.');
        await loadTopics(state.topicsCourse.id);
      } else if (kind === 'reject-payment') {
        await api(`/api/admin/payments/${state.rejectingPaymentId}/decision`, { method: 'POST', body: { decision: 'reject', note: formObject(form).note } });
        state.rejectingPaymentId = null;
        toast('Payment rejected and the student will see your reason.');
        await loadAdminTab(); render();
      } else if (kind === 'settings') {
        await api('/api/admin/settings', { method: 'PUT', body: formObject(form) });
        toast('Payment settings saved.');
        state.adminSettings = (await api('/api/admin/settings')).settings || {}; render();
      } else if (kind === 'import') {
        const file = $('#excel-file', form)?.files?.[0];
        if (!file) throw new Error('Choose an Excel workbook first.');
        const result = await uploadExcelWithProgress(file);
        const root = $('#import-result');
        root.innerHTML = `<div class="callout" style="margin-top:18px">${result.processed} row(s) imported/updated · ${result.failed} row(s) need attention.</div><div class="import-results">${result.results.map((r) => `<div class="import-result ${r.ok ? 'ok' : 'fail'}"><strong>${r.ok ? '✓' : '!'}</strong><span>Row ${r.row}: ${escapeHtml(r.message)}</span></div>`).join('')}</div>`;
        toast(`${result.processed} row(s) imported; ${result.failed} failed.`);
      } else if (kind === 'security-questions') {
        await api('/api/me/security/questions', { method: 'PUT', body: formObject(form) });
        if (state.userDashboard) state.userDashboard.recovery_question_count = 3;
        toast('Recovery questions saved.'); await go('learning');
      } else if (kind === 'change-password') {
        await api('/api/me/change-password', { method: 'POST', body: formObject(form) });
        toast('Password changed.'); form.reset();
      } else if (kind === 'quiz-settings') {
        await api(`/api/admin/courses/${state.adminQuizEditor.course.id}/quiz`, { method: 'PUT', body: formObject(form) });
        toast('Quiz settings saved.'); await loadAdminQuiz(state.adminQuizEditor.course.id);
      } else if (kind === 'quiz-question') {
        const data = formObject(form);
        const indexed = [0,1,2,3].map((index) => ({ oldIndex: index, value: String(data[`option_${index}`] || '').trim() })).filter((entry) => entry.value);
        const correctOldIndex = Number(data.correct_option);
        const correctIndex = indexed.findIndex((entry) => entry.oldIndex === correctOldIndex);
        if (correctIndex < 0) throw new Error('Select a correct answer that has text.');
        const payload = { prompt: data.prompt, options: indexed.map((entry) => entry.value), correct_option: correctIndex, sort_order: Number(data.sort_order || state.adminQuizQuestions.length + 1) };
        const questionId = state.editor?.item?.id;
        await api(questionId ? `/api/admin/quiz-questions/${questionId}` : `/api/admin/courses/${state.adminQuizEditor.course.id}/quiz/questions`, { method: questionId ? 'PATCH' : 'POST', body: payload });
        state.editor = null; toast(questionId ? 'Quiz question updated.' : 'Quiz question added.'); await loadAdminQuiz(state.adminQuizEditor.course.id);
      } else if (kind === 'quiz-submit') {
        const answers = {};
        for (const question of state.courseQuiz.questions) {
          const selected = $(`input[name="question_${question.id}"]:checked`, form);
          if (!selected) throw new Error('Answer every question before submitting.');
          answers[question.id] = Number(selected.value);
        }
        state.quizResult = await api(`/api/courses/${state.courseDetail.id}/quiz/submit`, { method: 'POST', body: { answers } });
        if (state.quizResult.passed) state.courseQuiz.certificate = {
          certificate_code: state.quizResult.certificate_code,
          issued_at: state.quizResult.issued_at,
          score: state.quizResult.score,
          correct_count: state.quizResult.correct_count,
          question_count: state.quizResult.question_count,
        };
        toast(state.quizResult.passed ? 'Quiz passed · your certificate is ready.' : `Quiz score ${Number(state.quizResult.score).toFixed(0)}%. Review and try again.`);
        state.userDashboard = null; render();
      }
    } catch (error) {
      if (kind === 'import' && $('#upload-progress-label')) $('#upload-progress-label').textContent = error.message;
      showFormError(form, error.message);
    } finally {
      if (submitButton?.isConnected) { submitButton.disabled = false; submitButton.textContent = originalSubmitLabel; }
    }
  });

  document.addEventListener('input', async (event) => {
    if (event.target.id === 'course-search') {
      state.search = event.target.value;
      window.clearTimeout(state.searchTimer);
      state.searchTimer = window.setTimeout(async () => {
        try { await loadCourses(); const active = $('#course-search'); const start = active?.selectionStart; render(); const next = $('#course-search'); next?.focus(); if (start !== null && start !== undefined) next?.setSelectionRange(start, start); }
        catch (error) { toast(error.message, 'error'); }
      }, 220);
    }
    if (event.target.id === 'user-search') {
      window.clearTimeout(state.userTimer);
      const value = event.target.value;
      state.userSearch = value;
      state.userTimer = window.setTimeout(async () => {
        try { state.adminUsers = (await api(`/api/admin/users?q=${encodeURIComponent(value)}`)).users || []; render(); const input = $('#user-search'); input?.focus(); input?.setSelectionRange(value.length, value.length); }
        catch (error) { toast(error.message, 'error'); }
      }, 250);
    }
  });

  document.addEventListener('change', async (event) => {
      if (event.target.id === 'payment-filter') {
      state.adminPaymentFilter = event.target.value;
      try { state.adminPayments = (await api(`/api/admin/payments?status=${encodeURIComponent(state.adminPaymentFilter)}`)).payments || []; render(); }
      catch (error) { toast(error.message, 'error'); }
    }
  });

  async function start() {
    try {
      const [, , recovery] = await Promise.all([
        refreshSession(),
        loadCourses(),
        api('/api/recovery-questions'),
      ]);
      state.recoveryQuestions = recovery.questions || [];
      render();
    } catch (error) {
      $('#app-main').innerHTML = `<div class="empty-state"><h3>Could not connect to the application</h3><p>${escapeHtml(error.message)}</p><p>Check your database configuration, then refresh this page.</p><button class="btn btn-primary" data-action="retry">Try again</button></div>`;
    }
  }

  document.addEventListener('click', async (event) => {
    const retry = event.target.closest('[data-action="retry"]');
    if (retry) {
      $('#app-main').innerHTML = '<div class="loading-state"><span class="spinner"></span>Connecting…</div>';
      await start();
    }
  });

  start();
})();
