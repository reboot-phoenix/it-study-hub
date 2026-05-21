import { auth } from "./firebase.js";
import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  sendPasswordResetEmail
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

// DOM Elements
const loginPanel = document.getElementById('loginPanel');
const signupPanel = document.getElementById('signupPanel');
const tabLoginBtn = document.getElementById('tabLoginBtn');
const tabSignupBtn = document.getElementById('tabSignupBtn');

const errorBanner = document.getElementById('errorBanner');
const errorText = document.getElementById('errorText');
const successBanner = document.getElementById('successBanner');
const successText = document.getElementById('successText');

// UI Helper Functions
function switchTab(tab) {
  clearBanners();
  if (tab === 'login') {
    tabLoginBtn.classList.add('active');
    tabSignupBtn.classList.remove('active');
    loginPanel.classList.add('active');
    signupPanel.classList.remove('active');
  } else {
    tabSignupBtn.classList.add('active');
    tabLoginBtn.classList.remove('active');
    signupPanel.classList.add('active');
    loginPanel.classList.remove('active');
  }
}

function showError(msg) {
  errorText.textContent = msg;
  errorBanner.classList.add('show');
  successBanner.classList.remove('show');
}

function showSuccess(msg) {
  successText.textContent = msg;
  successBanner.classList.add('show');
  errorBanner.classList.remove('show');
}

function clearBanners() {
  errorBanner.classList.remove('show');
  successBanner.classList.remove('show');
}

function togglePass(inputId, btn) {
  const input = document.getElementById(inputId);
  if (input.type === 'password') {
    input.type = 'text';
    btn.textContent = '🙈';
  } else {
    input.type = 'password';
    btn.textContent = '👁';
  }
}

function setLoading(btnId, spinnerId, textId, loading, label) {
  const btn = document.getElementById(btnId);
  const spinner = document.getElementById(spinnerId);
  const text = document.getElementById(textId);
  btn.disabled = loading;
  spinner.style.display = loading ? 'block' : 'none';
  text.textContent = loading ? 'Please wait...' : label;
}

// Map messy Firebase Error codes to nice user messages
function friendlyError(code) {
  switch(code) {
    case 'auth/user-not-found': return 'No account found with this email.';
    case 'auth/wrong-password': return 'Incorrect password. Try again.';
    case 'auth/email-already-in-use': return 'This email is already registered.';
    case 'auth/weak-password': return 'Password is too weak (min. 6 characters).';
    case 'auth/invalid-email': return 'Please enter a valid email address.';
    case 'auth/missing-password': return 'Password field cannot be empty.';
    default: return 'Authentication failed. Please try again.';
  }
}

// --- EVENT LISTENERS FOR TAB SWITCHES ---
tabLoginBtn.addEventListener('click', () => switchTab('login'));
tabSignupBtn.addEventListener('click', () => switchTab('signup'));
document.getElementById('linkToSignup').addEventListener('click', (e) => { e.preventDefault(); switchTab('signup'); });
document.getElementById('linkToLogin').addEventListener('click', (e) => { e.preventDefault(); switchTab('login'); });

// --- PASSWORD SHOW/HIDE TOGGLES ---
document.getElementById('toggleLoginPass').addEventListener('click', function() {
  togglePass('loginPassword', this);
});
document.getElementById('toggleSignupPass').addEventListener('click', function() {
  togglePass('signupPassword', this);
});

// 🔥 ==========================================
// 🔥 FIREBASE: SIGN IN LOGIC
// 🔥 ==========================================
document.getElementById('loginBtn').addEventListener('click', () => {
  clearBanners();
  const email = document.getElementById('loginEmail').value.trim();
  const password = document.getElementById('loginPassword').value;

  if (!email || !password) {
    showError('Please fill in all fields.');
    return;
  }

  setLoading('loginBtn', 'loginSpinner', 'loginBtnText', true, 'Sign In');

  signInWithEmailAndPassword(auth, email, password)
    .then((userCredential) => {
      showSuccess("Login Successful! Redirecting...");
      setTimeout(() => {
        window.location.href = "index.html"; 
      }, 1000);
    })
    .catch((error) => {
      setLoading('loginBtn', 'loginSpinner', 'loginBtnText', false, 'Sign In');
      showError(friendlyError(error.code));
    });
});

// 🔥 ==========================================
// 🔥 FIREBASE: SIGN UP LOGIC
// 🔥 ==========================================
document.getElementById('signupBtn').addEventListener('click', () => {
  clearBanners();
  const email = document.getElementById('signupEmail').value.trim();
  const password = document.getElementById('signupPassword').value;
  const passErr = document.getElementById('passError');

  if (!email || !password) {
    showError('Please fill in all fields.');
    return;
  }

  if (password.length < 8) {
    passErr.classList.add('show');
    document.getElementById('signupPassword').classList.add('input-error');
    return;
  }
  passErr.classList.remove('show');
  document.getElementById('signupPassword').classList.remove('input-error');

  setLoading('signupBtn', 'signupSpinner', 'signupBtnText', true, 'Create Account');

  createUserWithEmailAndPassword(auth, email, password)
    .then((userCredential) => {
      showSuccess("Account Created Successfully! Redirecting...");
      setTimeout(() => {
        window.location.href = "index.html";
      }, 1000);
    })
    .catch((error) => {
      setLoading('signupBtn', 'signupSpinner', 'signupBtnText', false, 'Create Account');
      showError(friendlyError(error.code));
    });
});

// 🔥 ==========================================
// 🔥 FIREBASE: FORGOT PASSWORD LOGIC
// 🔥 ==========================================
document.getElementById('forgotPassLink').addEventListener('click', (e) => {
  e.preventDefault();
  clearBanners();
  const email = document.getElementById('loginEmail').value.trim();

  if (!email) {
    showError('Enter your email in the box first, then click Forgot Password.');
    return;
  }

  sendPasswordResetEmail(auth, email)
    .then(() => {
      showSuccess('Password reset link sent! Check your inbox.');
    })
    .catch((error) => {
      showError(friendlyError(error.code));
    });
});
