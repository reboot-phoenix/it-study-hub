// ══════════════════════════════════════════════════
//  IT Study Hub — Premium Modal + Razorpay
//  Include this script on any course page.
//  Call: window.openPremiumModal(courseName)
//
//  HOW PAYMENT WORKS
//  1. Browser asks our Worker (/api/create-order) for an order. The Worker
//     decides the price; the browser never sends an amount.
//  2. Razorpay Checkout opens for that order.
//  3. After payment the browser sends Razorpay's three values to
//     /api/verify-payment. The Worker checks the signature, asks Razorpay
//     whether the payment really happened, and only then writes the plan.
//  4. /api/razorpay-webhook does the same if the browser closes early.
//  This file never writes plan data to Firestore.
// ══════════════════════════════════════════════════

(function() {

const PLANS = [
  {
    id: 'basic',
    name: 'Starter',
    price: 199,
    period: 'one-time',
    tag: '',
    color: '#6b6b80',
    features: [
      'Unlock any 2 courses of your choice',
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
      'Profile Elite badge <i class="ti ti-trophy" aria-hidden="true" style="font-size:16px;vertical-align:-2px;"></i>',
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
      user-select: none; -webkit-user-select: none;
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
function pmEsc(s) {
  return String(s).replace(/[&<>"'`]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;','`':'&#96;'}[c]));
}

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
        <div class="pm-eyebrow"><i class="ti ti-bolt" aria-hidden="true" style="font-size:16px;vertical-align:-2px;"></i> Unlock Premium Access</div>
        <h2 class="pm-title">LEVEL UP YOUR<br><span style="color:#c8f135">LEARNING</span></h2>
        <p class="pm-sub">
          ${courseName ? `Get full access to <strong style="color:#f0f0f8">${pmEsc(courseName)}</strong> and beyond.` : 'Get full access to all courses, advanced materials, and exclusive resources.'}
        </p>
      </div>
      <div class="pm-grid" id="pm-plans-grid">${plansHTML}</div>
      <div class="pm-footer">
        <i class="ti ti-lock" aria-hidden="true" style="font-size:16px;vertical-align:-2px;"></i> Secure payment via Razorpay &nbsp;·&nbsp;
        <span>UPI · Cards · Net Banking · Wallets</span> &nbsp;·&nbsp;
        Instant access after payment
      </div>
    </div>`;

  overlay.addEventListener('click', e => {
    if (e.target === overlay) window.closePremiumModal();
  });

  // Hook cursor — support both ID conventions, pointer devices only
  if (window.matchMedia('(pointer: fine)').matches) {
    const cursor = document.getElementById('cursor') || document.getElementById('cur');
    const ring   = document.getElementById('cursorRing') || document.getElementById('curR');
    if (cursor) {
      overlay.querySelectorAll('a, button').forEach(el => {
        el.addEventListener('mouseenter', () => {
          cursor.style.transform = 'scale(2)';
          if (ring) ring.style.transform = 'scale(1.5)';
        });
        el.addEventListener('mouseleave', () => {
          cursor.style.transform = 'scale(1)';
          if (ring) ring.style.transform = 'scale(1)';
        });
      });
    }
  }

  return overlay;
}

// ── Show already-premium state ──
function showAlreadyPremium(plan) {
  const grid = document.getElementById('pm-plans-grid');
  if (!grid) return;
  grid.outerHTML = `<div class="pm-already">
    <div class="pm-crown"><i class="ti ti-crown" aria-hidden="true" style="font-size:16px;vertical-align:-2px;"></i></div>
    <h3>You're already on ${plan} plan!</h3>
    <p>All premium content is unlocked. Enjoy learning.</p>
    <button class="pm-btn pm-btn-lime" style="margin-top:24px;max-width:200px;" onclick="window.closePremiumModal()">Close ✕</button>
  </div>`;
  // Hook cursor into newly-added button
  if (window.matchMedia('(pointer: fine)').matches) {
    const cursor = document.getElementById('cursor') || document.getElementById('cur');
    const ring   = document.getElementById('cursorRing') || document.getElementById('curR');
    if (cursor) {
      document.querySelectorAll('.pm-already button').forEach(el => {
        el.addEventListener('mouseenter', () => { cursor.style.transform='scale(2)'; if(ring) ring.style.transform='scale(1.5)'; });
        el.addEventListener('mouseleave', () => { cursor.style.transform='scale(1)'; if(ring) ring.style.transform='scale(1)'; });
      });
    }
  }
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
  const isPremiumUser = data.plan === 'pro' || data.plan === 'elite' || data.role === 'admin';

  if (isPremiumUser) {
    const overlay = buildModal(courseName);
    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add('pm-visible'));
    document.body.style.overflow = 'hidden';
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
function pmShowSuccess(planName, planId) {
  const modal = document.querySelector('.pm-modal');
  if (!modal) return;
  modal.innerHTML = `
    <div style="text-align:center; padding:60px 20px;">
      <div style="font-size:56px; margin-bottom:20px;"><i class="ti ti-confetti" aria-hidden="true" style="font-size:16px;vertical-align:-2px;"></i></div>
      <h2 style="font-family:'Bebas Neue','Syne',sans-serif; font-size:36px; color:#c8f135; margin-bottom:12px;">WELCOME TO ${planName.toUpperCase()}!</h2>
      <p style="color:#9090a8; font-size:14px; margin-bottom:28px;">Your premium access is now active. All locked content is unlocked.</p>
      <button class="pm-btn pm-btn-lime" style="max-width:240px;margin:0 auto;" onclick="window.closePremiumModal(); location.reload();">START LEARNING →</button>
    </div>`;
  hidePremiumCTAs(planId);
}

function pmShowMessage(title, text) {
  const modal = document.querySelector('.pm-modal');
  if (!modal) { alert(title + '\n\n' + text); return; }
  modal.innerHTML = `
    <div style="text-align:center; padding:60px 20px;">
      <h2 style="font-family:'Bebas Neue','Syne',sans-serif; font-size:32px; color:#f0f0f8; margin-bottom:12px;"></h2>
      <p style="color:#9090a8; font-size:14px; margin-bottom:28px;"></p>
      <button class="pm-btn pm-btn-lime" style="max-width:240px;margin:0 auto;" onclick="window.closePremiumModal(); location.reload();">REFRESH</button>
    </div>`;
  modal.querySelector('h2').textContent = title;
  modal.querySelector('p').textContent = text;
}

async function pmApi(path, body, user) {
  const idToken = await user.getIdToken();
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + idToken },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

window.handlePremiumPurchase = async function(btn, planId, amount, planName) {
  const originalText = btn.textContent;
  const reset = () => { btn.textContent = originalText; btn.disabled = false; };
  btn.textContent = 'Loading...';
  btn.disabled = true;

  try {
    // Load Razorpay SDK if not already loaded
    if (!window.Razorpay) {
      await new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = 'https://checkout.razorpay.com/v1/checkout.js';
        script.onload = resolve;
        script.onerror = () => reject(new Error('Could not load the payment window. Check your connection.'));
        document.head.appendChild(script);
      });
    }

    const { getAuth } = await import('https://www.gstatic.com/firebasejs/12.13.0/firebase-auth.js');
    const auth = window._fbAuth || getAuth(window._fbApp);
    const user = auth.currentUser;
    if (!user) { alert('Please sign in first.'); reset(); return; }

    // The server picks the price and creates the order. `amount` from the page is ignored.
    const order = await pmApi('/api/create-order', { planId }, user);

    const options = {
      key: order.keyId,
      order_id: order.orderId,
      amount: order.amount,
      currency: order.currency,
      name: 'IT Study Hub',
      description: `${order.planName} Plan — Premium Access`,
      image: '',
      prefill: { name: user.displayName || '', email: user.email || '' },
      theme: { color: '#c8f135' },
      handler: async function(response) {
        pmShowMessage('Confirming payment…', 'Please wait a moment. Do not close this window.');
        const modalBtn = document.querySelector('.pm-modal button');
        if (modalBtn) modalBtn.style.display = 'none';
        // Try a few times: the payment can take a second to show as captured.
        for (let attempt = 0; attempt < 4; attempt++) {
          try {
            const result = await pmApi('/api/verify-payment', {
              razorpay_order_id: response.razorpay_order_id,
              razorpay_payment_id: response.razorpay_payment_id,
              razorpay_signature: response.razorpay_signature,
            }, user);
            pmShowSuccess(order.planName, result.plan);
            return;
          } catch (e) {
            console.warn('verify attempt failed:', e.message);
            await new Promise(r => setTimeout(r, 1500 * (attempt + 1)));
          }
        }
        pmShowMessage('Payment received',
          'We could not confirm it instantly. Your plan will activate automatically within a few minutes. ' +
          'If it does not, contact support with payment ID ' + response.razorpay_payment_id + '.');
      },
      modal: { backdropclose: false, ondismiss: reset }
    };

    const rzp = new window.Razorpay(options);
    rzp.on('payment.failed', function(resp) {
      reset();
      alert('Payment failed: ' + resp.error.description);
    });
    rzp.open();
  } catch (e) {
    console.error('Purchase error:', e);
    reset();
    alert(e.message || 'Payment gateway error. Please try again.');
  }
};

// ── Hide all premium CTAs for users who already paid ──
function hidePremiumCTAs(plan) {
  // Replace every "unlock premium" / "get premium" button with a "You're Premium" badge
  const badge = `<span class="pm-active-badge" style="
    display:inline-flex;align-items:center;gap:6px;
    background:rgba(200,241,53,0.1);
    border:1px solid rgba(200,241,53,0.3);
    color:#c8f135;
    font-family:'JetBrains Mono',monospace;
    font-size:11px;font-weight:700;
    letter-spacing:1px;padding:8px 16px;border-radius:8px;
    text-transform:uppercase;
  ">✓ ${plan.charAt(0).toUpperCase()+plan.slice(1)} Active</span>`;

  // Target buttons that call openPremiumModal
  document.querySelectorAll('[onclick*="openPremiumModal"], [onclick*="openPremiumModal"]').forEach(el => {
    el.outerHTML = badge;
  });

  // Target links to premium.html with common CTA text
  document.querySelectorAll('a[href="premium.html"]').forEach(el => {
    const text = el.textContent.trim().toLowerCase();
    if (text.includes('unlock') || text.includes('premium') || text.includes('upgrade') || text.includes('get ')) {
      el.outerHTML = badge;
    }
  });

  // Hide the nav "<i class="ti ti-bolt" aria-hidden="true" style="font-size:16px;vertical-align:-2px;"></i> Premium" link if user is already premium (optional — keep visible so they can see their plan)
  // We intentionally leave the nav link in place so users can review their plan
}

// ── Check premium status on every page load and hide CTAs if paid ──
async function checkAndHidePremiumCTAs() {
  try {
    const session = JSON.parse(localStorage.getItem('ish_session') || 'null');
    if (!session) return; // not logged in — nothing to do

    const { getAuth } = await import('https://www.gstatic.com/firebasejs/12.13.0/firebase-auth.js');
    const { getFirestore, doc, getDoc } = await import('https://www.gstatic.com/firebasejs/12.13.0/firebase-firestore.js');

    const auth = window._fbAuth || getAuth(window._fbApp);
    const user = await getCurrentUser(auth);
    if (!user) return;

    const db = window._fbDb || getFirestore(window._fbApp);
    const snap = await getDoc(doc(db, 'users', user.uid));
    if (!snap.exists()) return;

    const data = snap.data();
    const isPremium = data.plan === 'pro' || data.plan === 'elite' || data.role === 'admin';
    if (isPremium) {
      hidePremiumCTAs(data.plan || 'pro');
    }
  } catch(e) {
    // Silently fail — don't break the page if Firestore is unreachable
    console.warn('premium-modal: checkAndHidePremiumCTAs failed:', e);
  }
}

// Run the check after DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', checkAndHidePremiumCTAs);
} else {
  checkAndHidePremiumCTAs();
}

// ── ESC key to close ──
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') window.closePremiumModal?.();
});

})();
