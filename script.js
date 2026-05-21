import { auth } from "./firebase.js";
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

// DOM Interactive Elements
const navLoginBtn = document.getElementById('navLoginBtn');
const userAvatarBtn = document.getElementById('userAvatarBtn');
const avatarInitial = document.getElementById('avatarInitial');
const avatarName = document.getElementById('avatarName');
const ddEmail = document.getElementById('ddEmail');
const ddName = document.getElementById('ddName');
const userDropdown = document.getElementById('userDropdown');
const logoutBtn = document.getElementById('logoutBtn');
const heroAuthBtn = document.getElementById('heroAuthBtn');

// 🔄 Toggle Dashboard Dropdown Menu
if (userAvatarBtn) {
  userAvatarBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    userDropdown.classList.toggle('open');
  });
}

// Close dropdown if user clicks anywhere else on the screen
document.addEventListener('click', () => {
  if (userDropdown) userDropdown.classList.remove('open');
});

// 🛡️ SECURITY GUARD: Listen for login/logout actions instantly
onAuthStateChanged(auth, (user) => {
  if (user) {
    // 🟩 USER IS LOGGED IN
    if (navLoginBtn) navLoginBtn.style.display = 'none';
    if (userAvatarBtn) userAvatarBtn.classList.add('visible');
    
    // Extract name formatting from email address or setup profile initials
    const profileIdentifier = user.displayName || user.email || "Student";
    if (avatarInitial) avatarInitial.textContent = profileIdentifier[0].toUpperCase();
    if (avatarName) avatarName.textContent = profileIdentifier.split('@')[0];
    if (ddName) ddName.textContent = profileIdentifier.split('@')[0];
    if (ddEmail) ddEmail.textContent = user.email;

    // Change Hero UI buttons seamlessly so they don't prompt a sign-in anymore
    if (heroAuthBtn) {
      heroAuthBtn.textContent = "Go to Dashboard →";
      heroAuthBtn.href = "#courses"; // Jumps directly down to system courses area
    }
  } else {
    // 🟥 USER IS LOGGED OUT
    if (navLoginBtn) navLoginBtn.style.display = 'flex';
    if (userAvatarBtn) userAvatarBtn.classList.remove('visible');
    if (heroAuthBtn) {
      heroAuthBtn.textContent = "Sign In to Track Progress";
      heroAuthBtn.href = "Login.html";
    }
  }
});

// 🚪 SIGN OUT ACTION HANDLER
if (logoutBtn) {
  logoutBtn.addEventListener('click', () => {
    signOut(auth)
      .then(() => {
        window.location.reload(); // Instantly refreshes home screen to clear profile
      })
      .catch((error) => {
        alert("Error logging out: " + error.message);
      });
  });
}
