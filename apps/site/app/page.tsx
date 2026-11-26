'use client';

import './mockup.css';
import HyperDemo from './HyperDemo';

function Arrow() {
  return <span aria-hidden="true">↗</span>;
}

export default function HomePage() {
  return (
    <main className="site-shell" id="top">
      <header className="site-nav" aria-label="Primary navigation">
        <a className="brand" href="#top" aria-label="Hyper home">
          <span className="brand-mark">h</span>
          <span>hyper</span>
        </a>
        <nav aria-label="Site links">
          <a href="#features">Features</a>
          <a href="#how-it-works">How it works</a>
          <a href="#faq">FAQ</a>
        </nav>
        <a className="nav-action" href="#get-hyper">Get Hyper <Arrow /></a>
      </header>

      <section className="hero">
        <div className="hero-copy">
          <p className="eyebrow"><span className="eyebrow-dot" /> A little more room to think</p>
          <h1>Your browser,<br /><em>back in flow.</em></h1>
          <p className="lead">
            Tabs everywhere? Hyper brings your tabs, bookmarks, and history into one calm,
            searchable space. Less hunting. More doing.
          </p>
          <div className="hero-actions">
            <a className="primary-action" href="#get-hyper">Get Hyper <Arrow /></a>
            <a className="secondary-action" href="#features">See how it works <span aria-hidden="true">↓</span></a>
          </div>
          <div className="hero-proof" aria-label="Hyper features">
            <div className="proof-marks"><span>H</span><span>✳</span><span>↗</span></div>
            <p>Made for the way <strong>you</strong> work</p>
          </div>
        </div>

        <div className="hero-demo-wrap" id="demo">
          <span className="floating-note note-one"><i>✳</i> Find it instantly</span>
          <span className="floating-note note-two"><i>ϟ</i> Keep your headspace</span>
          <div className="hero-demo-frame">
            <HyperDemo />
          </div>
        </div>
      </section>

      <div className="ticker" aria-label="Hyper benefits">
        <div className="ticker-track">
          <span>Less tab chaos</span><i>✳</i><span>More deep work</span><i>✳</i>
          <span>Your flow, kept</span><i>✳</i><span>Less tab chaos</span><i>✳</i>
        </div>
      </div>

      <section className="feature-section" id="features">
        <div className="section-heading">
          <p className="eyebrow">The web, in its place</p>
          <h2>Everything you need.<br /><em>Right where you need it.</em></h2>
          <p>Hyper turns the sprawl of your browser into a space that makes sense to you.</p>
        </div>

        <div className="feature-grid">
          <article className="feature-card feature-spaces">
            <div className="feature-visual space-preview" aria-hidden="true">
              <div><span>◒</span><strong>General</strong><small>6 tabs</small></div>
              <div><span>✳</span><strong>Research</strong><small>12 tabs</small></div>
              <div><span>⌑</span><strong>Side projects</strong><small>4 tabs</small></div>
              <button type="button">＋</button>
            </div>
            <p className="feature-index">01 / Spaces</p>
            <h3>Give every thought a place.</h3>
            <p>Group tabs and bookmarks into focused spaces. Switch gears without losing your place—or your mind.</p>
          </article>

          <article className="feature-card feature-search">
            <div className="feature-visual search-preview" aria-hidden="true">
              <div className="search-mini-field"><span>⌕</span> figma design system <kbd>↵</kbd></div>
              <div className="search-mini-row"><i>◒</i><span><b>Figma Community</b><small>Tab · design space</small></span><em>↗</em></div>
              <div className="search-mini-row"><i>◉</i><span><b>Design systems handbook</b><small>Bookmark · reading</small></span><em>↗</em></div>
              <div className="search-mini-row"><i>◉</i><span><b>figma.com</b><small>History · yesterday</small></span><em>↗</em></div>
            </div>
            <p className="feature-index">02 / Search</p>
            <h3>There when you need it.</h3>
            <p>One quick search across open tabs, bookmarks, and history. Find it before you forget what you were looking for.</p>
          </article>

          <article className="feature-card feature-favourites">
            <div className="feature-visual favourites-preview" aria-hidden="true">
              <header><span>Favourites</span><b>•••</b></header>
              <div className="favourite-mini-grid">
                <span>✉<small>Gmail</small></span><span>●<small>Keep</small></span><span>◉<small>GitHub</small></span>
                <span>↗<small>Linear</small></span><span>⌑<small>Figma</small></span><span>＋<small>Add new</small></span>
              </div>
            </div>
            <p className="feature-index">03 / Quick access</p>
            <h3>Your daily web, at a glance.</h3>
            <p>Keep favourites and recent pages in a persistent grid. The things you use most, always one click away.</p>
          </article>
        </div>
      </section>

      <section className="flow-section" id="how-it-works">
        <div className="flow-mark" aria-hidden="true">h</div>
        <div>
          <p className="eyebrow">Made to move with you</p>
          <h2>Less managing.<br /><em>More momentum.</em></h2>
          <p>Hyper is a lightweight sidebar that fits into your browser—not another place to spend your time. Your spaces stay yours, and your next step is always close.</p>
          <a href="#get-hyper">Make room for focus <Arrow /></a>
        </div>
        <div className="shortcut-card" aria-hidden="true"><kbd>⌘ K</kbd><p>One shortcut<br />to find anything.</p></div>
      </section>

      <section className="cta-section" id="get-hyper">
        <div className="cta-mark" aria-hidden="true">h</div>
        <p className="eyebrow">Your browser can feel different</p>
        <h2>Find your <em>flow.</em></h2>
        <p>Make the web feel a little more like yours.</p>
        <a className="primary-action" href="mailto:hello@hyperbar.app?subject=Get%20Hyper">Get Hyper <Arrow /></a>
        <span>A calmer corner of the internet.</span>
      </section>

      <section className="faq-section" id="faq" aria-labelledby="faq-title">
        <div>
          <p className="eyebrow">Questions, answered</p>
          <h2 id="faq-title">A sidebar.<br />Not another app.</h2>
        </div>
        <dl>
          <div><dt>Does the demo touch my real browser data?</dt><dd>No. The live demo stores everything in React state in memory and resets on reload.</dd></div>
          <div><dt>Is this the actual extension interface?</dt><dd>Yes. The demo mounts Hyper’s production sidepanel components with a local demo adapter.</dd></div>
          <div><dt>What can I try?</dt><dd>Create and navigate tabs, switch spaces, make bookmarks and folders, search, rename items, and explore settings.</dd></div>
        </dl>
      </section>

      <footer>
        <a className="brand" href="#top"><span className="brand-mark">h</span><span>hyper</span></a>
        <p>Move through the web, your way.</p>
        <a href="mailto:hello@hyperbar.app">Say hello <Arrow /></a>
        <span>© 2025 Hyper</span>
      </footer>
    </main>
  );
}
