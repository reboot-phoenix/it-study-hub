// ══════════════════════════════════════════════════
//  IT Study Hub — Premium Modal + Razorpay
//  Include this script on any course page.
//  Call: window.openPremiumModal(courseName)
//
//  RAZORPAY SETUP REQUIRED:
//  1. Go to https://dashboard.razorpay.com
//  2. Settings → API Keys → Generate Test Key
//  3. Replace RZP_KEY_ID below with your key (rzp_test_xxxx)
//  4. When going live, swap to your live key (rzp_live_xxxx)
//
//  SECURITY NOTE:
//  This file handles the CLIENT side only.
//  After payment, Razorpay gives you 3 values:
//    - razorpay_payment_id
//    - razorpay_order_id
//    - razorpay_signature
//  In a real production app you MUST verify these on a server
//  (Firebase Cloud Function) before activating premium.
//  For now this is a student project so we write to Firestore
//  directly, which is acceptable at this stage.
// ══════════════════════════════════════════════════

(function() {

// ── REPLACE THIS WITH YOUR ACTUAL RAZORPAY TEST KEY ──
// Get it from: https://dashboard.razorpay.com → Settings → API Keys
const RZP_KEY_ID = 'rzp_test_TCbxQ8kFJk4J53';

const PLANS = [
  {
    id: 'basic',
    name: 'Starter',
    price: 199,
    period: 'one-time',
    tag: '',
    color: '#6b6b80',
    features: [
      'Unlock 1 course of your choice',
      'Advanced lesson materials',
      'Downloadable PDF notes',
      'Access for 6 months',
    ],
    cta: 'Get Starter'
  },
  {
    id: 'pro',
    name: 'Pro',
    price: 499,
    period: 'one-time',
    tag: 'MOST POPULAR',
    color: '#c8f135',
    features: [
      'Unlock ALL 6 courses',
      'Advanced + Expert lessons',
      'All PDFs & cheat sheets',
      'Priority quiz feedback',
      'Access for 12 months',
      'Certificate of completion',
    ],
    cta: 'Go Pro'
  },
  {
    id: 'elite',
    name: 'Elite',
    price: 999,
    period: 'lifetime',
    tag: 'BEST VALUE',
    color: '#f7b731',
    features: [
      'Everything in Pro',
      'Lifetime access — forever',
      'Early access to new courses',
      'Direct mentor Q&A sessions',
      'Exclusive Discord community',
      'Profile Elite badge 🏆',
    ],
    cta: 'Go Elite'
  }
];

// ── Inject styles once ──
if (!document.getElementById('pm-styles')) {
  const s = document.createElement('style');
  s.id = 'pm-styles';
  s.textContent = `
    .pm-overlay {
      position: fixed; inset: 0; z-index: 9999;
      background: rgba(0,0,0,0.85);
      backdrop-filter: blur(8px);
      display: flex; align-items: center; justify-content: center;
      padding: 20px;
      opacity: 0; transition: opacity 0.25s;
    }
    .pm-overlay.pm-visible { opacity: 1; }
    .pm-modal {
      background: #0a0a14;
      border: 1px solid rgba(255,255,255,0.1);
      border-radius: 20px;
      width: 100%; max-width: 880px;
      max-height: 90vh; overflow-y: auto;
      padding: 40px;
      transform: translateY(24px); transition: transform 0.3s ease;
      position: relative;
    }
    .pm-overlay.pm-visible .pm-modal { transform: translateY(0); }
    .pm-close {
      position: absolute; top: 20px; right: 20px;
      background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.1);
      color: #9090a8; border-radius: 8px; width: 32px; height: 32px;
      display: flex; align-items: center; justify-content: center;
      cursor: pointer; font-size: 18px; transition: all 0.2s;
    }
    .pm-close:hover { background: rgba(255,255,255,0.12); color: #f0f0f8; }
    .pm-header { text-align: center; margin-bottom: 36px; }
    .pm-eyebrow {
      font-family: 'JetBrains Mono', monospace; font-size: 11px;
      letter-spacing: 2px; text-transform: uppercase; color: #c8f135;
      margin-bottom: 10px;
    }
    .pm-title {
      font-family: 'Bebas Neue', 'Syne', sans-serif;
      font-size: clamp(32px, 5vw, 52px);
      color: #f0f0f8; line-height: 1;
      margin-bottom: 10px;
    }
    .pm-sub { font-size: 14px; color: #9090a8; max-width: 480px; margin: 0 auto; line-height: 1.6; }
    .pm-grid {
      display: grid; grid-template-columns: repeat(3,1fr);
      gap: 16px; margin-bottom: 28px;
    }
    @media(max-width:700px) { .pm-grid { grid-template-columns: 1fr; } }
    .pm-card {
      background: #0c0c18; border: 1px solid rgba(255,255,255,0.08);
      border-radius: 16px; padding: 28px 24px;
      display: flex; flex-direction: column; gap: 0;
      transition: border-color 0.2s, transform 0.2s;
      position: relative; overflow: hidden;
    }
    .pm-card.pm-popular {
      border-color: rgba(200,241,53,0.4);
      background: rgba(200,241,53,0.04);
    }
    .pm-card.pm-elite { border-color: rgba(247,183,49,0.35); background: rgba(247,183,49,0.03); }
    .pm-card:hover { transform: translateY(-4px); }
    .pm-badge {
      position: absolute; top: 0; right: 0;
      font-family: 'JetBrains Mono', monospace; font-size: 9px;
      letter-spacing: 1.5px; padding: 5px 12px;
      border-radius: 0 15px 0 10px;
      font-weight: 700;
    }
    .pm-badge-lime { background: #c8f135; color: #000; }
    .pm-badge-gold { background: #f7b731; color: #000; }
    .pm-plan-name {
      font-family: 'JetBrains Mono', monospace; font-size: 11px;
      letter-spacing: 2px; text-transform: uppercase; color: #6b6b80;
      margin-bottom: 12px;
    }
    .pm-price-row { display: flex; align-items: baseline; gap: 4px; margin-bottom: 6px; }
    .pm-rupee { font-size: 18px; color: #9090a8; margin-bottom: 2px; }
    .pm-amount {
      font-family: 'Bebas Neue', 'Syne', sans-serif;
      font-size: 48px; line-height: 1; color: #f0f0f8;
    }
    .pm-period { font-size: 12px; color: #6b6b80; margin-left: 4px; }
    .pm-divider { height: 1px; background: rgba(255,255,255,0.07); margin: 20px 0; }
    .pm-features { list-style: none; display: flex; flex-direction: column; gap: 10px; flex: 1; margin-bottom: 24px; }
    .pm-features li { font-size: 13px; color: #9090a8; display: flex; align-items: flex-start; gap: 8px; line-height: 1.4; }
    .pm-feat-check { flex-shrink: 0; margin-top: 1px; }
    .pm-btn {
      width: 100%; padding: 13px;
      border: none; border-radius: 10px;
      font-family: 'JetBrains Mono', monospace; font-size: 12px;
      font-weight: 700; letter-spacing: 1px; text-transform: uppercase;
      cursor: pointer; transition: all 0.2s;
    }
    .pm-btn-lime { background: #c8f135; color: #000; }
    .pm-btn-lime:hover { background: #d4ff3d; transform: translateY(-1px); }
    .pm-btn-gold { background: #f7b731; color: #000; }
    .pm-btn-gold:hover { background: #ffc84a; transform: translateY(-1px); }
    .pm-btn-ghost {
      background: transparent; color: #9090a8;
      border: 1px solid rgba(255,255,255,0.1);
    }
    .pm-btn-ghost:hover { border-color: rgba(255,255,255,0.25); color: #f0f0f8; }
    .pm-footer {
      text-align: center; font-family: 'JetBrains Mono', monospace;
      font-size: 11px; color: #6b6b80; letter-spacing: 0.5px;
    }
    .pm-footer span { color: #c8f135; }
    .pm-already {
      text-align: center; padding: 40px 20px;
      font-family: 'JetBrains Mono', monospace;
    }
    .pm-already .pm-crown { font-size: 48px; margin-bottom: 16px; }
    .pm-already h3 { font-size: 20px; color: #c8f135; margin-bottom: 8px; }
    .pm-already p { font-size: 13px; color: #9090a8; }
  `;
  document.head.appendChild(s);
}

// ── Build modal HTML ──
function buildModal(courseName) {
  const overlay = document.createElement('div');
  overlay.className = 'pm-overlay';
  overlay.id = 'premiumModal';

  const plansHTML = PLANS.map(plan => {
    const isPopular = plan.id === 'pro';
    const isElite   = plan.id === 'elite';
    const btnClass  = isPopular ? 'pm-btn-lime' : isElite ? 'pm-btn-gold' : 'pm-btn-ghost';
    const badge = plan.tag
      ? `<div class="pm-badge ${isElite ? 'pm-badge-gold' : 'pm-badge-lime'}">${plan.tag}</div>`
      : '';
    const feats = plan.features.map(f =>
      `<li><span class="pm-feat-check" style="color:${plan.color}">✓</span>${f}</li>`
    ).join('');

    return `
      <div class="pm-card ${isPopular ? 'pm-popular' : ''} ${isElite ? 'pm-elite' : ''}">
        ${badge}
        <div class="pm-plan-name">${plan.name}</div>
        <div class="pm-price-row">
          <span class="pm-rupee">₹</span>
          <span class="pm-amount">${plan.price}</span>
          <span class="pm-period">/ ${plan.period}</span>
        </div>
        <div class="pm-divider"></div>
        <ul class="pm-features">${feats}</ul>
        <button class="pm-btn ${btnClass}" onclick="window.handlePremiumPurchase(this, '${plan.id}', ${plan.price}, '${plan.name}')">${plan.cta}</button>
      </div>`;
  }).join('');

  overlay.innerHTML = `
    <div class="pm-modal">
      <button class="pm-close" onclick="window.closePremiumModal()">✕</button>
      <div class="pm-header">
        <div class="pm-eyebrow">⚡ Unlock Premium Access</div>
        <h2 class="pm-title">LEVEL UP YOUR<br><span style="color:#c8f135">LEARNING</span></h2>
        <p class="pm-sub">
          ${courseName ? `Get full access to <strong style="color:#f0f0f8">${courseName}</strong> and beyond.` : 'Get full access to all courses, advanced materials, and exclusive resources.'}
        </p>
      </div>
      <div class="pm-grid" id="pm-plans-grid">${plansHTML}</div>
      <div class="pm-footer">
        🔒 Secure payment via Razorpay &nbsp;·&nbsp;
        <span>UPI · Cards · Net Banking · Wallets</span> &nbsp;·&nbsp;
        Instant access after payment
      </div>
    </div>`;

  overlay.addEventListener('click', e => {
    if (e.target === overlay) window.closePremiumModal();
  });

  return overlay;
}

// ── Show already-premium state ──
function showAlreadyPremium(plan) {
  const grid = document.getElementById('pm-plans-grid');
  if (!grid) return;
  grid.outerHTML = `<div class="pm-already">
    <div class="pm-crown">👑</div>
    <h3>You're already on ${plan} plan!</h3>
    <p>All premium content is unlocked. Enjoy learning.</p>
  </div>`;
}

// ── Helper: wait for Firebase to restore auth session ──
function getCurrentUser(auth) {
  return new Promise((resolve) => {
    if (auth.currentUser !== null) {
      resolve(auth.currentUser);
      return;
    }
    const unsubscribe = auth.onAuthStateChanged(user => {
      unsubscribe();
      resolve(user);
    });
  });
}

// ── Public API ──
window.openPremiumModal = async function(courseName) {

  const { getAuth } = await import('https://www.gstatic.com/firebasejs/12.13.0/firebase-auth.js');
  const { getFirestore, doc, getDoc } = await import('https://www.gstatic.com/firebasejs/12.13.0/firebase-firestore.js');

  // Use pre-initialized instances from premium.html if available
  const auth = window._fbAuth || getAuth(window._fbApp);

  // Wait for Firebase to finish restoring session (currentUser is null until then)
  const user = await getCurrentUser(auth);

  if (!user) {
    if (confirm('Please sign in first to purchase a premium plan.\n\nGo to Login page?')) {
      window.location.href = 'Login.html';
    }
    return;
  }

  const db = window._fbDb || getFirestore(window._fbApp);
  const snap = await getDoc(doc(db, 'users', user.uid));
  const data = snap.exists() ? snap.data() : {};

  // FIX 3: isPremiumUser check uses Firestore data, not localStorage
  const isPremiumUser = data.plan === 'pro' || data.plan === 'elite' || data.isAdmin === true;

  if (isPremiumUser) {
    const overlay = buildModal(courseName);
    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add('pm-visible'));
    // FIX 4: was session.plan (undefined), now correctly uses data.plan from Firestore
    showAlreadyPremium(data.plan || 'Pro');
    return;
  }

  // FIX 5: Removed the dead `if (!session)` block that was left over from old code
  // We already handle the not-logged-in case above with `if (!user)`

  const overlay = buildModal(courseName);
  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add('pm-visible'));
  document.body.style.overflow = 'hidden';
};

window.closePremiumModal = function() {
  const overlay = document.getElementById('premiumModal');
  if (!overlay) return;
  overlay.classList.remove('pm-visible');
  setTimeout(() => { overlay.remove(); document.body.style.overflow = ''; }, 250);
};

// ── Razorpay Payment Handler ──
window.handlePremiumPurchase = async function(btn, planId, amount, planName) {
  const originalText = btn.textContent;
  btn.textContent = 'Loading...';
  btn.disabled = true;

  // Load Razorpay SDK if not already loaded
  if (!window.Razorpay) {
    await new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://checkout.razorpay.com/v1/checkout.js';
      script.onload = resolve;
      script.onerror = reject;
      document.head.appendChild(script);
    });
  }

  // Get current user for prefill (name/email only — not for auth)
  const { getAuth } = await import('https://www.gstatic.com/firebasejs/12.13.0/firebase-auth.js');
  const auth = window._fbAuth || getAuth(window._fbApp);
  const user = auth.currentUser;

  const options = {
    key: RZP_KEY_ID,
    amount: amount * 100, // Razorpay expects paise (₹499 → 49900)
    currency: 'INR',
    name: 'IT Study Hub',
    description: `${planName} Plan — Premium Access`,
    image: '',
    prefill: {
      name:  user?.displayName || '',
      email: user?.email || '',
    },
    theme: { color: '#c8f135' },
    handler: async function(response) {
      // ── Payment success callback ──
      // response contains:
      //   response.razorpay_payment_id  — proof of payment
      //   response.razorpay_order_id    — if you created an order server-side
      //   response.razorpay_signature   — for server-side verification
      //
      // What we do here: write plan to Firestore directly.
      // This is acceptable for a student project. For production,
      // you'd send response to a Firebase Cloud Function to verify
      // the signature before trusting it.

      try {
        const { getFirestore, doc, updateDoc } = await import('https://www.gstatic.com/firebasejs/12.13.0/firebase-firestore.js');
        const { getAuth } = await import('https://www.gstatic.com/firebasejs/12.13.0/firebase-auth.js');
        const db   = window._fbDb || getFirestore(window._fbApp);
        const auth = window._fbAuth || getAuth(window._fbApp);
        const user = auth.currentUser;

        if (user) {
          await updateDoc(doc(db, 'users', user.uid), {
            plan: planId,
            planActivatedAt: new Date().toISOString(),
            razorpayPaymentId: response.razorpay_payment_id
          });
        }
      } catch(e) {
        console.warn('Firestore update failed:', e);
        // Still show success UI — payment went through even if Firestore write failed
        // In production you'd handle this more carefully
      }

      // Show success screen inside modal
      const modal = document.querySelector('.pm-modal');
      if (modal) {
        modal.innerHTML = `
          <div style="text-align:center; padding:60px 20px;">
            <div style="font-size:56px; margin-bottom:20px;">🎉</div>
            <h2 style="font-family:'Bebas Neue','Syne',sans-serif; font-size:36px; color:#c8f135; margin-bottom:12px;">WELCOME TO ${planName.toUpperCase()}!</h2>
            <p style="color:#9090a8; font-size:14px; margin-bottom:28px;">Your premium access is now active. All locked content is unlocked.</p>
            <button onclick="window.closePremiumModal(); location.reload();" style="background:#c8f135; color:#000; border:none; padding:14px 32px; border-radius:10px; font-family:'JetBrains Mono',monospace; font-size:13px; font-weight:700; cursor:pointer; letter-spacing:1px;">START LEARNING →</button>
          </div>`;
      }
    },
    modal: {
      backdropclose: false,
      ondismiss: function() {
        btn.textContent = originalText;
        btn.disabled = false;
      }
    }
  };

  try {
    const rzp = new window.Razorpay(options);
    rzp.on('payment.failed', function(resp) {
      btn.textContent = originalText;
      btn.disabled = false;
      alert('Payment failed: ' + resp.error.description);
    });
    rzp.open();
  } catch(e) {
    console.error('Razorpay error:', e);
    btn.textContent = originalText;
    btn.disabled = false;
    alert('Payment gateway error. Please try again.');
  }
};

// ── ESC key to close ──
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') window.closePremiumModal?.();
});

})();
