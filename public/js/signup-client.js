import { initializeApp } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-app.js";
import { getAuth, createUserWithEmailAndPassword } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-auth.js";

const firebaseConfig = window.firebaseConfig;
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);

const signupForm = document.getElementById('signupForm');
const errorElem = document.getElementById('error');

signupForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = document.getElementById('email').value;
  const password = document.getElementById('password').value;

  try {
    const userCredential = await createUserWithEmailAndPassword(auth, email, password);
    const token = await userCredential.user.getIdToken();

    // Optionally send token to backend to create session
    const res = await fetch('/auth/sessionLogin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken: token }),
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Signup login failed");

    // 3. Update client UI if needed
    localStorage.setItem('user', 'true');
    
    window.location.href = "/"; // redirect after successful signup
  } catch (err) {
    console.error(err);
    errorElem.textContent = err.message || "Signup failed";
  }
});
