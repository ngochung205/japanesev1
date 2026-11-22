import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import {
  getAuth,
  GoogleAuthProvider,
  FacebookAuthProvider,
  signInWithPopup,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  sendPasswordResetEmail,
  updateProfile,
  signOut,
  onAuthStateChanged
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';
import {
  getDatabase,
  ref,
  get,
  update
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-database.js';

// =========================================================================
// 1. DÁN ĐÚNG ĐOẠN firebaseConfig ĐANG CHẠY CHUẨN CỦA BẠN VÀO ĐÂY
// =========================================================================
const firebaseConfig = {
  apiKey: "AIzaSyDBDqKhtxCGYgaPzcWCdXXj0gN1LHRr5oU",
  authDomain: "ngochung-8386.firebaseapp.com",
  databaseURL: "https://ngochung-8386-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "ngochung-8386",
  storageBucket: "ngochung-8386.firebasestorage.app",
  messagingSenderId: "109762952719",
  appId: "1:109762952719:web:a18cd99198f35b04522d7a",
  measurementId: "G-4SNW35HV30"
};

// Không đẩy API Key cá nhân hoặc biến nội bộ lên đám mây
const EXCLUDED_KEYS = [
  /gemini_key/i,
  /simli_key/i,
  /api_key/i,
  /^__jp_/i,
  /^firebase:/i
];

function isExcluded(key) {
  return !key || EXCLUDED_KEYS.some(rx => rx.test(key));
}
function encodeKey(k) {
  return encodeURIComponent(k).replace(/\./g, '%2E').replace(/~/g, '%7E');
}
function decodeKey(k) {
  try { return decodeURIComponent(k); } catch (e) { return k; }
}

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getDatabase(app);

const googleProvider = new GoogleAuthProvider();
googleProvider.setCustomParameters({ prompt: 'select_account' });
const facebookProvider = new FacebookAuthProvider();
facebookProvider.addScope('email');

const origSetItem = Storage.prototype.setItem;
const origRemoveItem = Storage.prototype.removeItem;

let currentUser = null;
let cloudReady = false;
let pendingPatch = {};
let pushTimer = null;

// =========================================================================
// 2. ĐỒNG BỘ DỮ LIỆU VĨNH VIỄN THEO TỪNG TÀI KHOẢN (users/{uid}/kv)
// =========================================================================
function queueCloudUpdate(key, value) {
  if (!currentUser || !cloudReady || isExcluded(key)) return;
  pendingPatch[encodeKey(key)] = (value === null || value === undefined)
    ? null
    : { v: String(value), t: Date.now() };
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => flushCloudPatch(), 250);
}

async function flushCloudPatch() {
  if (!currentUser) return;
  const keys = Object.keys(pendingPatch);
  if (!keys.length) return;

  const payload = { ...pendingPatch };
  pendingPatch = {};
  setSyncStatus('syncing', 'Đang lưu Cloud...');

  try {
    await update(ref(db, `users/${currentUser.uid}/kv`), payload);
    setSyncStatus('ok', 'Đã đồng bộ Cloud');
  } catch (err) {
    console.error('[CloudSync] Lỗi ghi dữ liệu:', err);
    pendingPatch = { ...payload, ...pendingPatch };
    setSyncStatus('error', 'Lỗi lưu Cloud');
  }
}

function clearPreviousAccountLocalData() {
  const keysToDelete = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && !isExcluded(k)) keysToDelete.push(k);
  }
  keysToDelete.forEach(k => origRemoveItem.call(localStorage, k));
}

async function syncUserFromCloud(user) {
  setSyncStatus('syncing', 'Đang tải dữ liệu...');
  const lastOwnerUid = localStorage.getItem('__jp_owner_uid') || '';

  if (lastOwnerUid && lastOwnerUid !== user.uid) {
    clearPreviousAccountLocalData();
  }

  try {
    await update(ref(db, `users/${user.uid}/profile`), {
      uid: user.uid,
      displayName: user.displayName || user.email?.split('@')[0] || 'Học viên',
      email: user.email || '',
      photoURL: user.photoURL || '',
      provider: user.providerData?.[0]?.providerId || 'password',
      lastLogin: Date.now()
    });

    const snap = await get(ref(db, `users/${user.uid}/kv`));
    const remote = snap.exists() ? snap.val() : null;
    let changed = false;

    if (remote && typeof remote === 'object') {
      for (const [encKey, entry] of Object.entries(remote)) {
        const key = decodeKey(encKey);
        if (isExcluded(key)) continue;
        const val = (entry && typeof entry === 'object' && 'v' in entry)
          ? String(entry.v)
          : String(entry);
        if (localStorage.getItem(key) !== val) {
          origSetItem.call(localStorage, key, val);
          changed = true;
        }
      }
    }

    origSetItem.call(localStorage, '__jp_owner_uid', user.uid);
    cloudReady = true;
    setSyncStatus('ok', 'Đã đồng bộ Cloud');

    if (changed && sessionStorage.getItem('__jp_reloaded_uid') !== user.uid) {
      sessionStorage.setItem('__jp_reloaded_uid', user.uid);
      window.location.reload();
      return;
    }

    enterMainStudyWorkspace(user);
  } catch (err) {
    console.error('[CloudSync] Lỗi tải dữ liệu:', err);
    setSyncStatus('error', 'Lỗi quyền Cloud');
    showAuthToast('❌ ' + explainAuthError(err), 5000);
  }
}

Storage.prototype.setItem = function (key, value) {
  origSetItem.call(this, key, value);
  if (this === window.localStorage) queueCloudUpdate(String(key), String(value));
};
Storage.prototype.removeItem = function (key) {
  origRemoveItem.call(this, key);
  if (this === window.localStorage) queueCloudUpdate(String(key), null);
};
window.addEventListener('storage', (e) => {
  if (e.storageArea === localStorage && e.key) queueCloudUpdate(e.key, e.newValue);
});

// =========================================================================
// 3. ĐỒNG BỘ THANH TIÊU ĐỀ & ĐÓNG MÀN HÌNH CHÀO CŨ KHI ĐÃ ĐĂNG NHẬP
// =========================================================================
let headerObserver = null;

function syncHeaderUserUI(user) {
  const header = document.querySelector('header');
  if (!header) return;
  const displayName = user.displayName || user.email?.split('@')[0] || 'Học viên';

  const applySync = () => {
    // 1. Đổi mọi chữ "Khách" (kể cả khi đi kèm icon 👤 Khách) thành tên tài khoản Cloud
    const walker = document.createTreeWalker(header, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (node.nodeValue && node.nodeValue.includes('Khách')) {
        node.nodeValue = node.nodeValue.replace(/Khách/g, displayName);
      }
    }

    // 2. Đổi nút "Đăng nhập" thành "Đăng xuất" nối thẳng Firebase
    header.querySelectorAll('button, a').forEach((btn) => {
      const txt = (btn.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
      if (txt === 'đăng nhập' && !btn.dataset.fbLogoutBound) {
        const newBtn = btn.cloneNode(true);
        newBtn.textContent = 'Đăng xuất';
        newBtn.title = 'Đăng xuất tài khoản Cloud';
        newBtn.removeAttribute('onclick');
        newBtn.dataset.fbLogoutBound = '1';
        newBtn.addEventListener('click', (e) => {
          e.preventDefault();
          handleSignOut();
        });
        btn.replaceWith(newBtn);
      }
    });
  };

  applySync();

  // Tự động giữ tên tài khoản nếu giao diện vẽ lại thanh tiêu đề khi chuyển tab
  if (!headerObserver) {
    headerObserver = new MutationObserver(() => {
      if (currentUser) applySync();
    });
    headerObserver.observe(header, { childList: true, subtree: true, characterData: true });
  }
}

function enterMainStudyWorkspace(user) {
  if (authScreenEl) authScreenEl.classList.remove('show');
  document.body.style.overflow = '';

  const guestLinks = Array.from(document.querySelectorAll('a, button, span'));
  for (const el of guestLinks) {
    if (el.closest('#jp-cloud-auth-screen, #fb-user-pill')) continue;
    const txt = (el.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
    if (txt.includes('truy cập trang web mà không cần đăng nhập')) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) { el.click(); break; }
    }
  }

  const applyWorkspaceUI = () => {
    document.querySelectorAll(
      '[id*="login" i], [id*="auth" i], [id*="welcome" i], [id*="forgot" i], ' +
      '[class*="login-screen" i], [class*="auth-screen" i], [class*="welcome-screen" i], ' +
      '[class*="login-overlay" i], [class*="auth-overlay" i]'
    ).forEach(el => {
      if (el.id === 'jp-cloud-auth-screen' || el.id === 'fb-user-pill' || el.closest('#jp-cloud-auth-screen, #fb-user-pill, #tom-ai-overlay')) return;
      const r = el.getBoundingClientRect();
      if (r.width > 240 && r.height > 200) el.style.display = 'none';
    });

    syncHeaderUserUI(user);
    if (typeof window.setTomButtonVisible === 'function') window.setTomButtonVisible(true);
  };

  setTimeout(applyWorkspaceUI, 160);
  setTimeout(() => syncHeaderUserUI(user), 550);
  window.dispatchEvent(new CustomEvent('firebase-user-ready', { detail: user }));
}

// =========================================================================
// 4. XỬ LÝ ĐĂNG NHẬP / ĐĂNG KÝ / QUÊN MẬT KHẨU / GOOGLE / FACEBOOK
// =========================================================================
function explainAuthError(err) {
  const code = err?.code || '';
  if (code === 'auth/invalid-credential' || code === 'auth/wrong-password' || code === 'auth/user-not-found') {
    return 'Email hoặc mật khẩu chưa đúng. Hãy kiểm tra lại nhé!';
  }
  if (code === 'auth/email-already-in-use') {
    return 'Email này đã được đăng ký rồi. Hãy chuyển sang tab Đăng nhập nhé!';
  }
  if (code === 'auth/weak-password') {
    return 'Mật khẩu quá ngắn (cần tối thiểu 6 ký tự).';
  }
  if (code === 'auth/invalid-email') {
    return 'Địa chỉ Email chưa đúng định dạng.';
  }
  if (code === 'auth/unauthorized-domain') {
    return 'Tên miền này chưa được mở khóa trong Firebase → Authentication → Settings → Authorized domains.';
  }
  if (code === 'auth/operation-not-allowed') {
    return 'Chưa bật phương thức đăng nhập này trong Firebase → Authentication → Sign-in method.';
  }
  if (code === 'auth/popup-closed-by-user') {
    return 'Bạn đã đóng cửa sổ đăng nhập trước khi hoàn tất.';
  }
  if (code === 'auth/popup-blocked') {
    return 'Trình duyệt đang chặn Popup. Hãy cho phép Popup rồi thử lại.';
  }
  return err?.message || 'Có lỗi xảy ra, vui lòng thử lại.';
}

async function handleSignOut() {
  try {
    await flushCloudPatch();
    cloudReady = false;
    await signOut(auth);
    clearPreviousAccountLocalData();
    origRemoveItem.call(localStorage, '__jp_owner_uid');
    sessionStorage.removeItem('__jp_reloaded_uid');
    showAuthToast('👋 Đã đăng xuất an toàn!');
    setTimeout(() => window.location.reload(), 300);
  } catch (err) {
    showAuthToast('❌ Lỗi đăng xuất: ' + err.message);
  }
}

window.signOutFirebaseAccount = handleSignOut;

// =========================================================================
// 5. GIAO DIỆN MÀN HÌNH ĐĂNG NHẬP 100% FIREBASE CLOUD (LIQUID GLASS)
// =========================================================================
let authScreenEl = null;
let userPillEl = null;
let toastEl = null;
let toastTimer = null;

function injectStyles() {
  if (document.getElementById('jp-cloud-auth-style')) return;
  const st = document.createElement('style');
  st.id = 'jp-cloud-auth-style';
  st.textContent = `
    #jp-cloud-auth-screen {
      position: fixed;
      inset: 0;
      z-index: 99992;
      display: none;
      align-items: center;
      justify-content: center;
      padding: 20px;
      background:
        radial-gradient(620px circle at 15% 15%, rgba(56, 189, 248, 0.22), transparent 60%),
        radial-gradient(640px circle at 85% 85%, rgba(129, 140, 248, 0.24), transparent 60%),
        radial-gradient(460px circle at 50% 50%, rgba(236, 72, 153, 0.14), transparent 65%),
        #060913;
      font-family: 'Plus Jakarta Sans', system-ui, -apple-system, sans-serif;
      color: #f8fafc;
      overflow-y: auto;
    }
    #jp-cloud-auth-screen.show { display: flex; }

    .jp-auth-card {
      width: 100%;
      max-width: 430px;
      background: rgba(15, 23, 42, 0.76);
      backdrop-filter: blur(18px);
      -webkit-backdrop-filter: blur(18px);
      border: 1px solid rgba(255, 255, 255, 0.16);
      box-shadow: 0 28px 70px rgba(0, 0, 0, 0.58), inset 0 1px 0 rgba(255, 255, 255, 0.18);
      border-radius: 26px;
      padding: 28px 26px 24px;
      display: flex;
      flex-direction: column;
      gap: 16px;
    }

    .jp-auth-brand {
      text-align: center;
    }
    .jp-auth-logo {
      width: 56px;
      height: 56px;
      margin: 0 auto 10px;
      border-radius: 18px;
      padding: 2px;
      background: linear-gradient(135deg, #38bdf8, #6366f1, #ec4899);
      overflow: hidden;
    }
    .jp-auth-logo img {
      width: 100%;
      height: 100%;
      object-fit: cover;
      border-radius: 16px;
      display: block;
      background: #0f172a;
    }
    .jp-auth-brand h2 {
      font-size: 21px;
      font-weight: 800;
      letter-spacing: -0.3px;
    }
    .jp-auth-brand h2 span { color: #f43f5e; }
    .jp-auth-brand p {
      font-size: 12.5px;
      color: #94a3b8;
      margin-top: 4px;
    }

    .jp-auth-tabs {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 6px;
      padding: 4px;
      border-radius: 14px;
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid rgba(255, 255, 255, 0.08);
    }
    .jp-auth-tab {
      padding: 9px 10px;
      border: none;
      border-radius: 11px;
      background: transparent;
      color: #94a3b8;
      font-family: inherit;
      font-size: 13px;
      font-weight: 700;
      cursor: pointer;
      transition: background-color 0.08s ease, color 0.08s ease;
    }
    .jp-auth-tab.active {
      background: linear-gradient(135deg, #2563eb, #4f46e5);
      color: #ffffff;
    }

    .jp-auth-form {
      display: flex;
      flex-direction: column;
      gap: 11px;
    }
    .jp-field {
      display: flex;
      flex-direction: column;
      gap: 5px;
    }
    .jp-field label {
      font-size: 12px;
      font-weight: 700;
      color: #cbd5e1;
    }
    .jp-field input {
      width: 100%;
      padding: 11px 13px;
      border-radius: 13px;
      border: 1px solid rgba(255, 255, 255, 0.14);
      background: rgba(6, 9, 19, 0.72);
      color: #f8fafc;
      font-family: inherit;
      font-size: 14px;
      outline: none;
      transition: border-color 0.08s ease;
    }
    .jp-field input:focus { border-color: #38bdf8; }

    .jp-forgot-row {
      display: flex;
      justify-content: flex-end;
      margin-top: -4px;
    }
    .jp-link-btn {
      background: none;
      border: none;
      color: #38bdf8;
      font-family: inherit;
      font-size: 12.5px;
      font-weight: 700;
      cursor: pointer;
      padding: 2px 0;
    }
    .jp-link-btn:hover { text-decoration: underline; }

    .jp-submit-btn {
      width: 100%;
      padding: 12px;
      border-radius: 14px;
      border: none;
      background: linear-gradient(135deg, #2563eb 0%, #4f46e5 55%, #06b6d4 100%);
      color: #ffffff;
      font-family: inherit;
      font-size: 14px;
      font-weight: 800;
      cursor: pointer;
      box-shadow: 0 10px 24px rgba(37, 99, 235, 0.36);
      transition: transform 0.08s ease, filter 0.08s ease;
    }
    .jp-submit-btn:hover:not(:disabled) { transform: translateY(-1px); filter: brightness(1.08); }
    .jp-submit-btn:disabled { opacity: 0.55; cursor: not-allowed; }

    .jp-divider {
      display: flex;
      align-items: center;
      gap: 10px;
      color: #64748b;
      font-size: 11.5px;
      font-weight: 700;
    }
    .jp-divider::before, .jp-divider::after {
      content: '';
      flex: 1;
      height: 1px;
      background: rgba(255, 255, 255, 0.1);
    }

    .jp-social-row {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 10px;
    }
    .jp-social-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      padding: 10px 12px;
      border-radius: 13px;
      border: 1px solid rgba(255, 255, 255, 0.14);
      font-family: inherit;
      font-size: 13px;
      font-weight: 700;
      cursor: pointer;
      transition: transform 0.08s ease, filter 0.08s ease;
    }
    .jp-social-btn:hover:not(:disabled) { transform: translateY(-1px); filter: brightness(1.06); }
    .jp-social-btn:disabled { opacity: 0.55; cursor: not-allowed; }
    .jp-social-btn.google { background: #ffffff; color: #0f172a; }
    .jp-social-btn.facebook { background: #1877f2; color: #ffffff; }

    .jp-cloud-note {
      text-align: center;
      font-size: 11.5px;
      color: #64748b;
      line-height: 1.45;
    }

    /* Thẻ tài khoản đang đăng nhập ở góc dưới bên trái */
    #fb-user-pill {
      position: fixed;
      left: 16px;
      bottom: 16px;
      z-index: 99985;
      display: none;
      align-items: center;
      gap: 10px;
      padding: 6px 12px 6px 7px;
      border-radius: 999px;
      background: rgba(15, 23, 42, 0.86);
      backdrop-filter: blur(14px);
      -webkit-backdrop-filter: blur(14px);
      border: 1px solid rgba(255, 255, 255, 0.16);
      box-shadow: 0 12px 32px rgba(0, 0, 0, 0.42);
      font-family: 'Plus Jakarta Sans', system-ui, sans-serif;
      color: #f8fafc;
      max-width: calc(100vw - 190px);
    }
    #fb-user-pill.show { display: inline-flex; }
    .fb-user-avatar {
      width: 34px; height: 34px; border-radius: 50%; object-fit: cover;
      border: 2px solid #38bdf8; background: #1e293b; flex-shrink: 0;
    }
    .fb-user-meta { display: flex; flex-direction: column; min-width: 0; line-height: 1.25; }
    .fb-user-name {
      font-size: 12.5px; font-weight: 800; white-space: nowrap;
      overflow: hidden; text-overflow: ellipsis; max-width: 150px;
    }
    .fb-user-sync { font-size: 10.5px; color: #94a3b8; display: inline-flex; align-items: center; gap: 5px; font-weight: 600; }
    .fb-sync-dot { width: 7px; height: 7px; border-radius: 50%; background: #10b981; flex-shrink: 0; }
    .fb-logout-btn {
      margin-left: 2px; padding: 6px 11px; border-radius: 999px;
      border: 1px solid rgba(244, 63, 94, 0.35); background: rgba(244, 63, 94, 0.14);
      color: #fda4af; font-family: inherit; font-size: 11.5px; font-weight: 700; cursor: pointer;
    }
    .fb-logout-btn:hover { background: #f43f5e; color: #ffffff; }

    #fb-auth-toast {
      position: fixed;
      top: 18px; left: 50%;
      transform: translateX(-50%) translateY(-90px);
      z-index: 999999;
      background: #0f172a; color: #f8fafc;
      border: 1px solid #38bdf8;
      padding: 10px 18px; border-radius: 999px;
      font-family: 'Plus Jakarta Sans', system-ui, sans-serif;
      font-size: 13px; font-weight: 700;
      box-shadow: 0 12px 32px rgba(0, 0, 0, 0.5);
      max-width: 90vw; text-align: center;
      transition: transform 0.2s ease;
    }
    #fb-auth-toast.show { transform: translateX(-50%) translateY(0); }
  `;
  document.head.appendChild(st);
}

function buildAuthUI() {
  injectStyles();

  if (!authScreenEl) {
    authScreenEl = document.createElement('div');
    authScreenEl.id = 'jp-cloud-auth-screen';
    authScreenEl.innerHTML = `
      <div class="jp-auth-card">
        <div class="jp-auth-brand">
          <div class="jp-auth-logo">
            <img src="logo.jpg" alt="Logo" onerror="this.src='ai_avatar.png';" />
          </div>
          <h2>japanese<span>V1</span> Studio</h2>
          <p>Đăng nhập Cloud — Lưu vĩnh viễn tài khoản, tiến độ học & lịch sử cùng Tom</p>
        </div>

        <div class="jp-auth-tabs" id="jp-auth-tabs">
          <button type="button" class="jp-auth-tab active" data-mode="login">Đăng nhập</button>
          <button type="button" class="jp-auth-tab" data-mode="register">Đăng ký</button>
        </div>

        <!-- Form Đăng nhập / Đăng ký -->
        <form class="jp-auth-form" id="jp-email-form">
          <div class="jp-field" id="jp-name-field" style="display:none;">
            <label for="jp-inp-name">Tên hiển thị</label>
            <input type="text" id="jp-inp-name" placeholder="Ví dụ: Ngọc Hưng" autocomplete="name" />
          </div>
          <div class="jp-field">
            <label for="jp-inp-email">Email</label>
            <input type="email" id="jp-inp-email" placeholder="nhapemail@gmail.com" required autocomplete="email" />
          </div>
          <div class="jp-field" id="jp-pwd-field">
            <label for="jp-inp-pwd">Mật khẩu</label>
            <input type="password" id="jp-inp-pwd" placeholder="Tối thiểu 6 ký tự" required autocomplete="current-password" />
          </div>
          <div class="jp-forgot-row" id="jp-forgot-row">
            <button type="button" class="jp-link-btn" id="jp-btn-show-forgot">Quên mật khẩu?</button>
          </div>
          <button type="submit" class="jp-submit-btn" id="jp-btn-submit">Đăng nhập</button>
        </form>

        <!-- Form Quên mật khẩu -->
        <form class="jp-auth-form" id="jp-forgot-form" style="display:none;">
          <div class="jp-field">
            <label for="jp-inp-reset-email">Nhập Email đã đăng ký</label>
            <input type="email" id="jp-inp-reset-email" placeholder="nhapemail@gmail.com" required />
          </div>
          <button type="submit" class="jp-submit-btn" id="jp-btn-reset">Gửi link đặt lại mật khẩu về Gmail</button>
          <div style="text-align:center;">
            <button type="button" class="jp-link-btn" id="jp-btn-back-login">← Quay lại Đăng nhập</button>
          </div>
        </form>

        <div class="jp-divider">hoặc tiếp tục nhanh bằng</div>

        <div class="jp-social-row">
          <button type="button" class="jp-social-btn google" id="jp-btn-google">
            <svg width="16" height="16" viewBox="0 0 24 24"><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/><path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/></svg>
            Google
          </button>
          <button type="button" class="jp-social-btn facebook" id="jp-btn-facebook">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M22 12c0-5.52-4.48-10-10-10S2 6.48 2 12c0 4.99 3.66 9.13 8.44 9.88v-6.99H7.9V12h2.54V9.8c0-2.51 1.49-3.89 3.78-3.89 1.09 0 2.24.2 2.24.2v2.46h-1.26c-1.24 0-1.63.77-1.63 1.56V12h2.78l-.44 2.89h-2.34v6.99C18.34 21.13 22 16.99 22 12z"/></svg>
            Facebook
          </button>
        </div>

        <div class="jp-cloud-note">☁️ Bảo mật & đồng bộ vô thời hạn qua Firebase Cloud</div>
      </div>
    `;
    document.body.appendChild(authScreenEl);
    bindAuthFormEvents();
  }

  if (!userPillEl) {
    userPillEl = document.createElement('div');
    userPillEl.id = 'fb-user-pill';
    userPillEl.innerHTML = `
      <img class="fb-user-avatar" id="fb-user-avatar" src="" alt="Avatar" />
      <div class="fb-user-meta">
        <span class="fb-user-name" id="fb-user-name">Học viên</span>
        <span class="fb-user-sync"><span class="fb-sync-dot" id="fb-sync-dot"></span><span id="fb-sync-text">Đã đồng bộ Cloud</span></span>
      </div>
      <button type="button" class="fb-logout-btn" id="fb-btn-logout">Đăng xuất</button>
    `;
    userPillEl.querySelector('#fb-btn-logout').addEventListener('click', handleSignOut);
    document.body.appendChild(userPillEl);
  }

  if (!toastEl) {
    toastEl = document.createElement('div');
    toastEl.id = 'fb-auth-toast';
    document.body.appendChild(toastEl);
  }
}

function bindAuthFormEvents() {
  let mode = 'login';
  const tabsWrap = authScreenEl.querySelector('#jp-auth-tabs');
  const emailForm = authScreenEl.querySelector('#jp-email-form');
  const forgotForm = authScreenEl.querySelector('#jp-forgot-form');
  const nameField = authScreenEl.querySelector('#jp-name-field');
  const forgotRow = authScreenEl.querySelector('#jp-forgot-row');
  const btnSubmit = authScreenEl.querySelector('#jp-btn-submit');
  const inpName = authScreenEl.querySelector('#jp-inp-name');
  const inpEmail = authScreenEl.querySelector('#jp-inp-email');
  const inpPwd = authScreenEl.querySelector('#jp-inp-pwd');
  const inpResetEmail = authScreenEl.querySelector('#jp-inp-reset-email');
  const btnReset = authScreenEl.querySelector('#jp-btn-reset');
  const btnGoogle = authScreenEl.querySelector('#jp-btn-google');
  const btnFacebook = authScreenEl.querySelector('#jp-btn-facebook');

  function switchMode(nextMode) {
    mode = nextMode;
    tabsWrap.querySelectorAll('.jp-auth-tab').forEach(t => {
      t.classList.toggle('active', t.dataset.mode === nextMode);
    });
    if (nextMode === 'forgot') {
      tabsWrap.style.display = 'none';
      emailForm.style.display = 'none';
      forgotForm.style.display = 'flex';
      inpResetEmail.value = inpEmail.value.trim();
      inpResetEmail.focus();
    } else {
      tabsWrap.style.display = 'grid';
      forgotForm.style.display = 'none';
      emailForm.style.display = 'flex';
      const isReg = nextMode === 'register';
      nameField.style.display = isReg ? 'flex' : 'none';
      forgotRow.style.display = isReg ? 'none' : 'flex';
      btnSubmit.textContent = isReg ? 'Tạo tài khoản Cloud' : 'Đăng nhập';
      inpPwd.autocomplete = isReg ? 'new-password' : 'current-password';
    }
  }

  tabsWrap.querySelectorAll('.jp-auth-tab').forEach(tab => {
    tab.addEventListener('click', () => switchMode(tab.dataset.mode));
  });
  authScreenEl.querySelector('#jp-btn-show-forgot').addEventListener('click', () => switchMode('forgot'));
  authScreenEl.querySelector('#jp-btn-back-login').addEventListener('click', () => switchMode('login'));

  emailForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = inpEmail.value.trim();
    const pwd = inpPwd.value;
    const name = inpName.value.trim();
    if (!email || !pwd) return;

    btnSubmit.disabled = true;
    btnSubmit.textContent = mode === 'register' ? 'Đang tạo tài khoản...' : 'Đang đăng nhập...';
    try {
      if (mode === 'register') {
        const cred = await createUserWithEmailAndPassword(auth, email, pwd);
        if (name) await updateProfile(cred.user, { displayName: name });
        showAuthToast('✅ Tạo tài khoản Cloud thành công!');
      } else {
        await signInWithEmailAndPassword(auth, email, pwd);
        showAuthToast('✅ Đăng nhập thành công!');
      }
    } catch (err) {
      showAuthToast('❌ ' + explainAuthError(err), 4500);
    } finally {
      btnSubmit.disabled = false;
      btnSubmit.textContent = mode === 'register' ? 'Tạo tài khoản Cloud' : 'Đăng nhập';
    }
  });

  forgotForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = inpResetEmail.value.trim();
    if (!email) return;
    btnReset.disabled = true;
    btnReset.textContent = 'Đang gửi email...';
    try {
      await sendPasswordResetEmail(auth, email);
      showAuthToast('📩 Đã gửi link đặt lại mật khẩu! Hãy kiểm tra Gmail (cả mục Thư rác).', 5500);
      switchMode('login');
    } catch (err) {
      showAuthToast('❌ ' + explainAuthError(err), 4500);
    } finally {
      btnReset.disabled = false;
      btnReset.textContent = 'Gửi link đặt lại mật khẩu về Gmail';
    }
  });

  async function runSocial(provider, btn) {
    btnGoogle.disabled = true;
    btnFacebook.disabled = true;
    try {
      const res = await signInWithPopup(auth, provider);
      showAuthToast(`✅ Xin chào, ${res.user.displayName || 'bạn'}!`);
    } catch (err) {
      showAuthToast('❌ ' + explainAuthError(err), 4800);
    } finally {
      btnGoogle.disabled = false;
      btnFacebook.disabled = false;
    }
  }

  btnGoogle.addEventListener('click', () => runSocial(googleProvider, btnGoogle));
  btnFacebook.addEventListener('click', () => runSocial(facebookProvider, btnFacebook));
}

function setSyncStatus(state, text) {
  const dot = document.getElementById('fb-sync-dot');
  const lbl = document.getElementById('fb-sync-text');
  if (!dot || !lbl) return;
  const colors = { syncing: '#38bdf8', ok: '#10b981', error: '#f43f5e' };
  dot.style.background = colors[state] || '#94a3b8';
  lbl.textContent = text;
}

function showAuthToast(msg, duration = 3200) {
  buildAuthUI();
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), duration);
}

// =========================================================================
// 6. KHỞI CHẠY & LẮNG NGHE TRẠNG THÁI ĐĂNG NHẬP
// =========================================================================
function initAuthListener() {
  buildAuthUI();

  onAuthStateChanged(auth, async (user) => {
    currentUser = user;
    if (user) {
      authScreenEl.classList.remove('show');
      userPillEl.classList.add('show');

      const avatarImg = document.getElementById('fb-user-avatar');
      const nameEl = document.getElementById('fb-user-name');
      nameEl.textContent = user.displayName || user.email?.split('@')[0] || 'Học viên';
      avatarImg.src = user.photoURL || 'ai_avatar.png';
      avatarImg.onerror = () => { avatarImg.src = 'logo.jpg'; };

      await syncUserFromCloud(user);
    } else {
      cloudReady = false;
      userPillEl.classList.remove('show');
      authScreenEl.classList.add('show');
      document.body.style.overflow = 'hidden';
      if (typeof window.setTomButtonVisible === 'function') window.setTomButtonVisible(false);
    }
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initAuthListener);
} else {
  initAuthListener();
}