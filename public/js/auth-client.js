import { initializeApp } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-app.js";
import { getAuth, signInWithEmailAndPassword } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-auth.js";

const firebaseConfig = window.firebaseConfig;
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);

const loginForm = document.getElementById('loginForm');
const errorElem = document.getElementById('error');
const logoutBtn = document.getElementById('logoutBtn');

loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = document.getElementById('email').value;
  const password = document.getElementById('password').value;

  try {
    const userCredential = await signInWithEmailAndPassword(auth, email, password);
    const token = await userCredential.user.getIdToken();

    const res = await fetch('/auth/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ idToken: token }),
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Login failed");

    errorElem.textContent = "";
    logoutBtn.style.display = 'block';
    loginForm.style.display = 'none';

    // After receiving verification response
    if (res.ok) {
      // store session/local info
      localStorage.setItem('user', 'true');
      // redirect to home
      window.location.href = "/";
    }

  } catch (err) {
    console.error(err);
    errorElem.textContent = "Invalid credentials or network error. " + err;
  }
});

logoutBtn.addEventListener('click', async () => {
  await fetch('/auth/sessionLogout', { method: 'POST' });
  localStorage.removeItem('user');
  logoutBtn.style.display = 'none';
  loginForm.style.display = 'block';
  window.location.href = "/auth/login";
});

