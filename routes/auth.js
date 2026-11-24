import express from "express";
import { getAuth } from "../config/firebase.js";
import { verifyFirebaseToken } from '../middleware/authMiddleware.js';
import User from "../models/user.js"; // our Firestore user model

const router = express.Router();

router.get('/test', (req, res) => {
  res.json({ message: 'Token verified!', user: { test: true } });
});

router.post('/sessionLogin', async (req, res, next) => {
  const idToken = req.body.idToken;
  const expiresIn = 60 * 60 * 24 * 5 * 1000; // 5 days
  try {
    const decodedToken = await getAuth().verifyIdToken(idToken);

    // Create Firestore user if not exists
    const user = new User(decodedToken.uid);
    const profile = await user.getProfile();
    if (!profile) {
      await user.setProfile({
        uid: decodedToken.uid,
        email: decodedToken.email || null,
        createdAt: new Date(),
      });
      console.log(`Created Firestore user doc for UID: ${decodedToken.uid}`);
    }
        
    const sessionCookie = await getAuth().createSessionCookie(idToken, { expiresIn });
    res.cookie('session', sessionCookie, {
      httpOnly: true,
      // secure: true was dropping this cookie on every plain-http request, so
      // the Firebase session never survived the redirect in development
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: expiresIn,
    });

    // Who the user is, not just a token. The id token expires in an hour
    // while the session lasts days, so storing only that left the app unable
    // to say who was signed in for most of the session's life.
    req.session.user = {
      uid: decodedToken.uid,
      email: decodedToken.email || null,
      displayName: decodedToken.name || profile?.displayName || null,
      // Whether this person maintains the map, decided once at sign-in.
      //
      // A Firebase custom claim, and deliberately NOT a field on their own
      // user document: almost everyone signing in is an ordinary user, and
      // a profile is the one record they might be able to write themselves,
      // which would make becoming an administrator a thing you could do to
      // yourself. A claim can only be set with the Admin SDK -- by this
      // server, on the People page, or by scripts/make-admin.js.
      admin: decodedToken.admin === true,
    };

    // finish writing the session before answering, or a redirect that follows
    // immediately can arrive before the session exists
    req.session.save((saveErr) => {
      if (saveErr) return next(saveErr);
      res.json({ status: 'success' });
    });
  } catch(err) {
    //res.status(401).json({ error: 'Invalid token' });
    next(err);
  }
});

router.post('/sessionLogout', (req, res) => {
  req.session.destroy(err => {
    if (err) console.error(err);
    // both cookies, or the browser keeps presenting a session id that no
    // longer resolves to anything
    res.clearCookie('session');
    res.clearCookie('wayfindr.sid');
    res.json({ status: 'logged out' });
  });
});


// POST /auth/verify
router.post("/verify", verifyFirebaseToken, async (req, res, next) => {
  try {
    // Ensure Firestore user doc exists
    const user = new User(req.user.uid);
    const profile = await user.getProfile();
    if (!profile) {
      await user.setProfile({
        uid: req.user.uid,
        email: req.user.email || null,
        createdAt: new Date(),
      });
      console.log(`Created Firestore user doc for UID: ${req.user.uid}`);
    }

    // The same shape /sessionLogin stores, because this is the other door
    // into the same session. A uid on its own cannot answer "is this person
    // an administrator" -- that is decided from the address they signed in
    // with -- so signing in through this route used to leave a listed admin
    // locked out of the tracer with no way to tell why.
    req.session.user = {
      uid: req.user.uid,
      email: req.user.email || profile?.email || null,
      displayName: req.user.name || profile?.displayName || null,
      admin: req.user.admin === true,
    };
    res.json({ message: "User verified", user: req.user });
  } catch(err) {
    next(err);
  }
});


router.get('/login', (req, res) => {
  if (req.session?.user) {
    return res.redirect("/");
  }
  res.render('login', { title: 'Login Page' });
});

router.get('/signup', (req, res) => {
  if (req.session?.user) return res.redirect("/");
  res.render('signup', { title: 'Sign Up' });
});

export default router;