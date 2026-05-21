// Firebase imports using web URLs so the browser understands them directly
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

// Your web app's live Firebase configuration
const firebaseConfig = {
  apiKey: "AIzaSyCu6ivnUU8wHVVtt3__eqaKxZMaKLAdT8A",
  authDomain: "it-study-hub.firebaseapp.com",
  projectId: "it-study-hub",
  storageBucket: "it-study-hub.firebasestorage.app",
  messagingSenderId: "566661039167",
  appId: "1:566661039167:web:122691d263631e404ea48a"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);

// Export auth so your login.js file can use it
export const auth = getAuth(app);
