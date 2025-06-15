const LIFF_ID = '2006779432-Qx8rBrlK';
let liffProfile = null;        // 登入後會放整個 profile
let initialProductId = null;

// 1. 預先解析 productId
(function parseInitialProductId() {
  const params = new URLSearchParams(window.location.search);
  initialProductId = params.get('productId'); // 可能是 null
})();

async function initLiffAndMaybeLogin() {
  try {
    await liff.init({ liffId: LIFF_ID });

    if (liff.isInClient()) {
      // LINE 內建瀏覽器才要登入
      if (!liff.isLoggedIn()) {
        const qs = window.location.search || '';
        const redirectUri = window.location.origin + window.location.pathname + qs;
        liff.login({ redirectUri });
        return true;
      }
      // 已登入 → 讀 profile
      const profile = await liff.getProfile();
      liffProfile = profile;
      const nameEl = document.getElementById('userName');
      if (nameEl) nameEl.textContent = profile.displayName || 'LINE 使用者';
    }
  } catch (err) {
    console.warn('LIFF init 失敗，跳過 LINE 登入流程', err);
  }
  return false;
}

// 若網址包含 ?clearCart=true，就清除購物車
if (new URLSearchParams(window.location.search).get('clearCart') === 'true') {
  localStorage.removeItem('cart');
}

const API_BASE = 'https://order013.de.r.appspot.com';
const pageSize = 4;
let cart = JSON.parse(localStorage.getItem('cart') || '{}');
let currentQuantityProduct = null;
let currentModalProduct = null;
const stockUpdateNotified = new Set();
// 加在 pageSize、cart、currentQuantityProduct… 的下面
let allProductsOriginal = [];
let allProducts = [];    // 先保留後端撈回來的 inventory 陣列
let nextIndex = 0;       // 用來記錄「下一筆要塞到哪一個欄位」
// ── 2. 關鍵：加入「是否已經在載入」的旗標，避免重複觸發 ──
let isLoadingMore = false;

// ── 3. 當初次載入完畢（或每次呼叫 showInitialProducts()）之後，開始監聽滾動事件 ──
function enableInfiniteScroll() {
  window.addEventListener('scroll', onScrollLoadMore);
}

// ── 4. 在 scroll 事件中判斷：只要到接近頁面底部，就呼叫 loadMoreProducts() ──
function onScrollLoadMore() {
  if (isLoadingMore) return;
  if (nextIndex >= allProducts.length) {
    window.removeEventListener('scroll', onScrollLoadMore);
    return;
  }
  const scrollTop = window.scrollY || window.pageYOffset;
  const viewportHeight = window.innerHeight;
  const fullHeight = document.documentElement.scrollHeight;
  if (scrollTop + viewportHeight >= fullHeight - 100) {
    isLoadingMore = true;
    loadMoreProducts();
    isLoadingMore = false;
  }
}

function refreshCartStocks() {
  const codes = Object.keys(cart);
  if (codes.length === 0) {
    return Promise.resolve();
  }
  const qs = codes.map(encodeURIComponent).join(',');
  return fetch(`${API_BASE}/api/getMultipleInventory?codes=${qs}`, {
    credentials: 'include'
  })
    .then(resp => {
      if (!resp.ok) throw new Error(`Status ${resp.status}`);
      return resp.json();
    })
    .then(latestMap => {
      codes.forEach(code => {
        const it = cart[code];
        const newStock = latestMap[code] ?? 0;
        it.stock = newStock;
        if (it.qty > newStock) {
          it.qty = newStock;
          displayInventoryModal(code, newStock);
        }
      });
      localStorage.setItem('cart', JSON.stringify(cart));
    })
    .catch(err => {
      console.error('同步購物車庫存失敗：', err);
    });
}

function openCartModal() {
  document.getElementById('cartSummary').innerHTML = '<p>載入懿昇…</p>';
  ModalManager.open('cartModal');

  refreshCartStocks()
    .then(() => updateCartDisplay())
    .catch(err => {
      console.error('同步購物車庫存失敗', err);
      document.getElementById('cartSummary').innerHTML = '<p>載入失敗，請稍後再試。</p>';
    });
}

function init() {
  const openCatBtn = document.getElementById('openCategoryModal');
  openCatBtn.addEventListener('click', e => {
    e.preventDefault();
    ModalManager.openCategoryList();
  });
  document.getElementById('cartCount').textContent = Object.keys(cart).length;
  document.querySelector('.hamburger')
    .addEventListener('click', () => document.getElementById('navMenu').classList.toggle('active'));
  document.getElementById('confirmQuantityBtn')
    .addEventListener('click', confirmQuantity);
  document.getElementById('confirmInventoryBtn')
    .addEventListener('click', () => { ModalManager.close('inventoryModal'); });
  document.getElementById('confirmEmptyCartBtn')
    .addEventListener('click', () => { ModalManager.close('emptyCartModal'); });
  document.getElementById('deleteQuantityBtn')
    .addEventListener('click', () => { deleteCartItem(currentQuantityProduct.code); });
  document.getElementById('modalSelectButton')
    .addEventListener('click', () => {
      ModalManager.close('productModal');
      selectProduct(currentModalProduct.code);
    });
  document.getElementById('openCartButton')
    .addEventListener('click', e => { e.preventDefault(); openCartModal(); });
  document.getElementById('checkoutButton')
    .addEventListener('click', goToCheckout);
  document.getElementById('quantityInput')
    .addEventListener('input', validateQuantity);
}

function goToCheckout() {
  const totalQty = Object.values(cart).reduce((sum, it) => sum + it.qty, 0);
  if (totalQty === 0) {
    ModalManager.open('emptyCartModal');
    return;
  }

  // 先把最新庫存都抓一遍，再更新畫面，最後才跳轉
  refreshCartStocks()
    .then(() => {
      updateCartDisplay();
      // 在前往 order.html 之前，就把 liffProfile 放到 localStorage（若存在）
      if (liffProfile) {
        localStorage.setItem('liffProfile', JSON.stringify({
          userId:      liffProfile.userId,
          displayName: liffProfile.displayName || '',
          pictureUrl:  liffProfile.pictureUrl || ''
        }));
      }
      window.location.href = '/order.html';
    })
    .catch(err => {
      console.error('同步庫存失敗，仍嘗試結帳：', err);
      if (liffProfile) {
        localStorage.setItem('liffProfile', JSON.stringify({
          userId:      liffProfile.userId,
          displayName: liffProfile.displayName || '',
          pictureUrl:  liffProfile.pictureUrl || ''
        }));
      }
      window.location.href = '/order.html';
    });
}

function showToast(message) {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.style.opacity = '1';
  clearTimeout(window.toastTimeout);
  window.toastTimeout = setTimeout(() => {
    toast.style.opacity = '0';
  }, 3500);
}

function decodeBase64Unicode(str) {
  const binary = atob(str);
  const bytes  = Uint8Array.from(binary, c => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function initProductInteractions() {
  const grid = document.getElementById('productsGrid');
  grid.addEventListener('click', e => {
    const t = e.target;
    if (!t.matches('.expand-hint, .btn-select, .product-image')) return;
    const inModal = Boolean(t.closest('.modal'));

    if (t.matches('.expand-hint')) {
      const code = t.dataset.code;
      const price = +t.dataset.price;
      const decoded = decodeBase64Unicode(t.dataset.introHtml);
      const imgEl = document.querySelector(`.product-image[data-code="${code}"]`);
      const stock = imgEl ? parseInt(imgEl.dataset.stock, 10) : 0;
      const image = imgEl ? imgEl.src : '';
      currentModalProduct = { code, intro: decoded, price: +price, stock, imageUrl: image };
      openProductModal(code, decoded, price, stock, image);

    } else if (t.matches('.btn-select') && !inModal) {
      const card     = t.closest('.product-card');
      const code     = t.dataset.code;
      const price    = +t.dataset.price;
      const stock    = +t.dataset.stock;
      const intro    = getIntroFromCard(card);
      const imageUrl = card.querySelector('.product-image').src;
      currentModalProduct = { code, intro, price, stock, imageUrl };
      selectProduct(code, price, true);

    } else if (t.matches('.btn-select') && inModal) {
      selectProduct(currentModalProduct.code, currentModalProduct.price, true);

    } else if (t.matches('.product-image')) {
      const { code, price, stock } = t.dataset;
      const img   = t;
      const card  = img.closest('.product-card');
      const intro = getIntroFromCard(card);
      currentModalProduct = { code, intro, price: +price, stock: +stock, imageUrl: img.src };
      openProductModal(code, intro, +price, +stock, img.src);
    }
  });

  function getIntroFromCard(card) {
    const full = card.querySelector('.full-intro');
    return full
      ? full.innerHTML
      : card.querySelector('.product-description').textContent;
  }
}

function loadAndRenderProducts() {
  return fetch(`${API_BASE}/api/getFullInventory`, { credentials: 'include' })
    .then(resp => {
      if (!resp.ok) throw new Error(`Status ${resp.status}`);
      return resp.json();
    })
    .then(({ inventory }) => {
      allProductsOriginal = inventory.slice();
      allProducts         = inventory.slice();
      console.table(allProductsOriginal);
      document.getElementById('col1').innerHTML = '';
      document.getElementById('col2').innerHTML = '';
      showInitialProducts();
      initProductInteractions();
      buildCategoryButtons(allProductsOriginal);
      enableInfiniteScroll();
    })
    .catch(err => {
      console.error('載入商品時出錯：', err);
      throw err;
    });
}

function buildProductCard({ mainCategory, code, intro, stock, price }) {
  const plainIntro = intro
    .replace(/<[^>]+>/g, '')
    .replace(/&(nbsp|emsp|ensp);/g, '')
    .trim();
  const isLong      = plainIntro.length > 20;
  const displayText = isLong ? plainIntro.slice(0, 20) : plainIntro;

  function encodeBase64Unicode(str) {
    return btoa(
      encodeURIComponent(str).replace(/%([0-9A-F]{2})/g, (_match, p1) =>
        String.fromCharCode(parseInt(p1, 16))
      )
    );
  }
  const safeIntro = encodeBase64Unicode(intro);

  const expandHint = isLong
    ? `<span class="expand-hint"
               style="color:#b5800d;cursor:pointer;"
               data-code="${code}"
               data-intro-html="${safeIntro}"
               data-price="${price}"
               data-stock="${stock}"
               data-image="/${code}.jpg"
           >…展開</span>`
    : '';

  const hiddenFull = `<div class="full-intro" style="display:none;">${intro}</div>`;

  if (stock === -1) {
    return `
      <div class="product-card" data-category="${mainCategory}">
        <img class="product-image"
             src="/${code}.jpg"
             alt="${code}"
             data-code="${code}"
             data-price="${price}"
             data-stock="${stock}" />
        <div class="product-content">
          <h2 class="product-title">${code}</h2>
          <p class="product-description">${displayText}${expandHint}</p>
          ${hiddenFull}
        </div>
      </div>
    `;
  }

  const priceHtml = `<div class="product-price">懿昇價: ${price} / 數量: ${stock}</div>`;
  const actionHtml = stock > 0
    ? `<button class="btn-select" data-code="${code}" data-price="${price}">加入背籃</button>`
    : `<span class="sold-out">你來遲了!</span>`;

  return `
    <div class="product-card" data-category="${mainCategory}">
      <img class="product-image"
           src="/${code}.jpg"
           alt="${code}"
           data-code="${code}"
           data-price="${price}"
           data-stock="${stock}" />
      <div class="product-content">
        <h2 class="product-title">${code}</h2>
        <p class="product-description">${displayText}${expandHint}</p>
        ${hiddenFull}
        ${priceHtml}
        ${actionHtml}
      </div>
    </div>
  `;
}

function showInitialProducts() {
  nextIndex = 0;
  const col1 = document.getElementById('col1');
  const col2 = document.getElementById('col2');
  col1.innerHTML = '';
  col2.innerHTML = '';

  for (let i = 0; i < pageSize && nextIndex < allProducts.length; i++, nextIndex++) {
    const item    = allProducts[nextIndex];
    const wrapper = document.createElement('div');
    wrapper.innerHTML = buildProductCard(item);
    const cardEl = wrapper.firstElementChild;
    if (nextIndex % 2 === 0) {
      col1.appendChild(cardEl);
    } else {
      col2.appendChild(cardEl);
    }
  }
}

function loadMoreProducts() {
  const col1 = document.getElementById('col1');
  const col2 = document.getElementById('col2');
  let added = 0;

  while (added < pageSize && nextIndex < allProducts.length) {
    const item    = allProducts[nextIndex];
    const wrapper = document.createElement('div');
    wrapper.innerHTML = buildProductCard(item);
    const cardEl = wrapper.firstElementChild;
    if (nextIndex % 2 === 0) {
      col1.appendChild(cardEl);
    } else {
      col2.appendChild(cardEl);
    }
    nextIndex++;
    added++;
  }
}

function buildCategoryButtons(inventory) {
  const categories = {};
  inventory.forEach(item => {
    if (item.mainCategory && !categories[item.mainCategory]) {
      categories[item.mainCategory] = item.categoryIntro;
    }
  });

  const catGrid = document.getElementById('categoryGrid');
  catGrid.innerHTML = '';

  for (const [cat, intro] of Object.entries(categories)) {
    const btn = document.createElement('button');
    btn.className = 'grid-item';
    btn.addEventListener('click', () => {
      filterCategory(cat);
      ModalManager.close('categoryModal');
      ModalManager.openCategoryDetail(cat, intro);
    });
    const img  = document.createElement('img');
    img.src    = `/${cat}.jpg`;
    img.alt    = `${cat} Icon`;
    const span = document.createElement('span');
    span.textContent = cat;
    btn.append(img, span);
    catGrid.append(btn);
  }

  const allBtn = document.createElement('button');
  allBtn.className = 'grid-item';
  allBtn.addEventListener('click', () => {
    filterCategory('all');
    ModalManager.close('categoryModal');
    ModalManager.openCategoryDetail('all', '這裡是全部內容的介紹文字');
  });
  const allImg  = document.createElement('img');
  allImg.src    = '/all.jpg';
  allImg.alt    = '全部';
  const allSpan = document.createElement('span');
  allSpan.textContent = '全部內容';
  allBtn.append(allImg, allSpan);
  catGrid.append(allBtn);
}

function filterCategory(category) {
  if (category === 'all') {
    allProducts = allProductsOriginal.slice();
  } else {
    allProducts = allProductsOriginal.filter(item => item.mainCategory === category);
  }
  nextIndex = 0;
  document.getElementById('col1').innerHTML = '';
  document.getElementById('col2').innerHTML = '';
  showInitialProducts();
  window.removeEventListener('scroll', onScrollLoadMore);
  enableInfiniteScroll();
  ModalManager.close('categoryDetailModal');
}

function openProductModal(code, introHtml, price, stock, imageUrl) {
  // 1. 把内容灌进去
  document.getElementById('modalImage').src          = imageUrl;
  document.getElementById('modalTitle').textContent   = code;
  document.getElementById('modalDescription').innerHTML = introHtml;

  const priceEl = document.getElementById('modalPrice');
  const btn     = document.getElementById('modalSelectButton');

  // 2. 根据 stock 显示／隐藏价格和按钮
  if (stock > 0) {
    priceEl.style.display = '';
    priceEl.textContent   = `懿昇價: ${price} / 數量: ${stock}`;
    btn.style.display     = 'inline-block';

    // —— 核心：**每次打开都重新绑定** onclick —— 
    btn.onclick = () => {
      ModalManager.close('productModal');
      // 将当前 code、price 传给 selectProduct
      selectProduct(code, /*notifyOnStockUpdate=*/true);
    };
  } else if (stock === 0) {
    priceEl.style.display = '';
    priceEl.textContent   = `懿昇價: ${price} / 數量: 0`;
    btn.style.display     = 'none';
  } else {
    priceEl.style.display = 'none';
    btn.style.display     = 'none';
  }

  // 3. 最后再打开 Modal
  ModalManager.open('productModal');
}


function modalSelectProduct() {
  const { code, stock, price } = currentModalProduct;
  ModalManager.close('productModal');
  selectProduct(code, price, true);
}

function fetchStockByCode(code) {
  return fetch(`${API_BASE}/api/getLatestInventory?code=${encodeURIComponent(code)}`, { credentials: 'include' })
    .then(resp => {
      if (!resp.ok) throw new Error(`Status ${resp.status}`);
      return resp.json();
    })
    .then(json => Number(json[code] ?? 0))
    .catch(err => {
      console.error(`取得 ${code} 庫存失敗：`, err);
      return 0;
    });
}

function selectProduct(code, notifyOnStockUpdate = true) {
  if (notifyOnStockUpdate) stockUpdateNotified.delete(code);

  const inv = JSON.parse(localStorage.getItem('inventory') || '{}');
  const cachedStock = inv[code] || 0;
  const price = Number(document.querySelector(`.product-image[data-code="${code}"]`)?.dataset.price || 0);
  currentQuantityProduct = { code, stock: cachedStock, price };

  document.getElementById('quantityModalTitle').textContent = `輸入 ${code} 數量`;
  document.getElementById('quantityModalInfo').textContent  = `請輸入數量 (最大 ${cachedStock})`;
  document.getElementById('quantityInput').value          = '';
  document.getElementById('quantityError').style.display   = 'none';
  document.getElementById('deleteQuantityBtn').style.display = cart[code] ? 'inline-block' : 'none';
  ModalManager.open('quantityModal');

  fetchStockByCode(code).then(updatedStock => {
    if (
      updatedStock !== currentQuantityProduct.stock &&
      !stockUpdateNotified.has(code)
    ) {
      currentQuantityProduct.stock = updatedStock;
      document.getElementById('quantityModalInfo').textContent =
        `請輸入數量 (最大 ${updatedStock})`;
      showToast(`庫存已更新：${code} 最多可訂 ${updatedStock}`);
      stockUpdateNotified.add(code);
      inv[code] = updatedStock;
      localStorage.setItem('inventory', JSON.stringify(inv));
      const imgEl = document.querySelector(`.product-image[data-code="${code}"]`);
      if (imgEl) {
        imgEl.dataset.stock = String(updatedStock);
        const card = imgEl.closest('.product-card');
        const priceElem = card.querySelector('.product-price');
        if (priceElem) priceElem.textContent = `懿昇價: ${price} / 數量: ${updatedStock}`;
        let btn    = card.querySelector('.btn-select');
        const soldEl   = card.querySelector('.sold-out');
        const contentDiv = card.querySelector('.product-content');

        if (updatedStock > 0) {
          if (!btn) {
            btn = document.createElement('button');
            btn.className = 'btn-select';
            btn.textContent = '加入背籃';
            btn.dataset.code  = code;
            btn.dataset.price = String(price);
            btn.addEventListener('click', () => selectProduct(code, true));
            contentDiv.append(btn);
          }
          if (soldEl) soldEl.remove();
        } else {
          if (btn) btn.remove();
          if (!soldEl) {
            const sold = document.createElement('div');
            sold.className = 'sold-out';
            sold.textContent = '【你來遲啦!】';
            contentDiv.append(sold);
          }
        }
      }
    }
  })
  .catch(err => {
    console.error(`後台拉 ${code} 庫存失敗：`, err);
  });
}

function refreshProductCards() {
  return fetchLatestInventory().then(latest => {
    document.querySelectorAll('.product-card').forEach(card => {
      const img      = card.querySelector('.product-image');
      const code     = img.dataset.code;
      const newStock = latest[code] ?? 0;
      img.dataset.stock = newStock;
      const priceElem = card.querySelector('.product-price');
      if (priceElem) priceElem.textContent = `懿昇價: ${img.dataset.price} / 數量: ${newStock}`;
      let btn = card.querySelector('.btn-select');
      if (newStock > 0 && !btn) {
        btn = document.createElement('button');
        btn.className = 'btn-select';
        btn.addEventListener('click', () => selectProduct(code, parseInt(img.dataset.price, 10), true));
        card.querySelector('.product-content').append(btn);
      }
      if (btn) {
        if (newStock === 0) {
          btn.remove();
          if (!card.querySelector('.sold-out')) {
            const sold = document.createElement('div');
            sold.className = 'sold-out';
            sold.textContent = '【你來遲啦!】';
            card.querySelector('.product-content').append(sold);
          }
        } else {
          const so = card.querySelector('.sold-out');
          if (so) so.remove();
          btn.disabled = false;
          btn.textContent = '加入背籃';
        }
      }
    });

    Object.keys(cart).forEach(code => {
      const it = cart[code];
      if (latest.hasOwnProperty(code)) {
        it.stock = latest[code];
        if (it.qty > it.stock) {
          it.qty = it.stock;
          displayInventoryModal(code, it.stock);
        }
      }
    });
    localStorage.setItem('cart', JSON.stringify(cart));
  });
}

function updateCartDisplay() {
  const codes    = Object.keys(cart);
  const kindNum  = codes.length;
  const totalQty = codes.reduce((sum, code) => sum + cart[code].qty, 0);

  const checkoutBtn = document.getElementById('checkoutButton');
  if (totalQty === 0) {
    checkoutBtn.style.display = 'none';
    checkoutBtn.disabled = true;
  } else {
    checkoutBtn.style.display = 'inline-block';
    checkoutBtn.disabled = false;
  }

  document.getElementById('cartCount').textContent = `${kindNum}`;
  document.getElementById('openCartButton').style.backgroundColor = kindNum ? '#bd1111' : '';

  const div = document.getElementById('cartSummary');
  if (!kindNum) {
    div.innerHTML = '你的背籃空空也，趕緊填滿它吧!';
  } else {
    let html  = `<p>已選 ${kindNum} 種品項，共 ${totalQty} 件</p><ul>`;
    let total = 65;
    codes.forEach(code => {
      const it  = cart[code];
      const sub = it.qty * it.price;
      total += sub;
      html += `<li>${code}: ${it.qty} x ${it.price} = ${sub} 元
                 <button onclick="editCartItem('${code}')" class="edit-button">修改</button></li>`;
    });
    html += `</ul><p>運費: 65 元</p><p>總金額: <strong>${total} 元</strong></p>`;
    div.innerHTML = html;
  }

  localStorage.setItem('cart', JSON.stringify(cart));
}

function editCartItem(code) {
  const it = cart[code];
  currentQuantityProduct = { code, stock: it.stock, price: it.price };
  document.getElementById('quantityModalTitle').textContent = `修改 ${code} 數量`;
  document.getElementById('quantityModalInfo').textContent  = `請輸入數量 (最大 ${it.stock})`;
  document.getElementById('quantityInput').value          = it.qty;
  document.getElementById('deleteQuantityBtn').style.display = 'inline-block';
  ModalManager.open('quantityModal');
}

function validateQuantity() {
  const qty = +document.getElementById('quantityInput').value;
  const err = document.getElementById('quantityError');
  if (!qty || qty < 1 || qty > currentQuantityProduct.stock) {
    err.textContent = !qty ? '請輸入數量' : `訂購數量超過擁有 (最大 ${currentQuantityProduct.stock})`;
    err.style.display = 'block';
  } else {
    err.style.display = 'none';
  }
}

function confirmQuantity() {
  const qty = +document.getElementById('quantityInput').value;
  if (qty && qty > 0 && qty <= currentQuantityProduct.stock) {
    cart[currentQuantityProduct.code] = {
      qty,
      price: currentQuantityProduct.price,
      stock: currentQuantityProduct.stock
    };
    localStorage.setItem('cart', JSON.stringify(cart));
    updateCartDisplay();
    ModalManager.close('quantityModal');
    showToast('加入背籃成功');
  } else {
    validateQuantity();
  }
}

function deleteCartItem(code) {
  delete cart[code];
  updateCartDisplay();
  ModalManager.close('quantityModal');
  showToast(`已刪除 ${code}`);
}

function displayInventoryModal(code, newStock) {
  document.getElementById('inventoryModalTitle').textContent = `${code} 已經快到甕底啦!`;
  document.getElementById('inventoryModalContent').textContent =
    `您所選擇的品項超出了目前數量，已自動調整為 ${newStock}，請核對背籃裡的所有品項數量。`;
  ModalManager.open('inventoryModal');
}

function debouncePromise(func, delay) {
  let timeout;
  return function(...args) {
    clearTimeout(timeout);
    return new Promise(resolve => {
      timeout = setTimeout(() => {
        Promise.resolve(func.apply(this, args)).then(resolve);
      }, delay);
    });
  };
}
const debouncedRefresh = debouncePromise(refreshProductCards, 300);

// 最後這段：先呼叫 initLiffAndMaybeShowProduct()，若 needLogin 就先 return
(async () => {
  // 1. 一開始解析 productId（支援 query string + hash）
  const params = new URLSearchParams(window.location.search);
  let initialProductId = params.get('productId') || null;
  if (!initialProductId && window.location.hash.startsWith('#productId=')) {
    initialProductId = decodeURIComponent(window.location.hash.slice(11));
  }

  // 2. LIFF 初始化與登入（如前所示）
  const needLogin = await initLiffAndMaybeLogin();
  if (needLogin) return;

  // 3. 綁定 UI、載入商品、建立 allProductsOriginal…
  init();
  loadAndRenderProducts()
    .then(() => {
      if (!initialProductId) return;

      // 4. 嘗試找商品
      const normalized = initialProductId.trim().toLowerCase();
      const target = allProductsOriginal.find(
        item => item.code.trim().toLowerCase() === normalized
      );

      if (target) {
        // 5a. 找到 → 自動彈框
        openProductModal(
          target.code,
          target.intro,
          target.price,
          target.stock,
          `/${target.code}.jpg`
        );

        // 6a. 可選：移除 URL 參數或 hash，避免重複
        history.replaceState(null, '', window.location.pathname);
      } else {
        // 5b. 找不到 → 提示
        alert(`查無商品「${initialProductId}」，請確認後再試！`);
      }
    })
    .catch(err => console.error('載入商品失敗：', err));
})();
