/*
  SOMNATH CAR AC & WASHING
  Optimized Firebase Realtime Database structure.

  This version DOES NOT download the full customers node when searching.
  It uses:
    mobileIndex/{mobileNo} -> customerId
    carIndex/{carNo}       -> customerId

  Bills are stored separately:
    customerBills/{customerId}/{billId}

  This keeps customer records small and makes lookup scalable.
*/

// ------------------------
// 1. ADD YOUR FIREBASE CONFIG
// ------------------------
const firebaseConfig = {
  apiKey: "AIzaSyAX0GYYoI_ldjitelcMXN2Py0TFA7nsKrY",
  authDomain: "somnath-customer-info.firebaseapp.com",
  databaseURL: "https://somnath-customer-info-default-rtdb.firebaseio.com/",
  projectId: "somnath-customer-info",
  storageBucket: "somnath-customer-info.firebasestorage.app",
  messagingSenderId: "1089402657275",
  appId: "1:1089402657275:web:e3be0a2ad6df1a50ea935e"
};

const CUSTOMER_PAGE_SIZE = 50;
const BILL_PAGE_SIZE = 50;

let db = null;
let currentCustomer = null;

// Customer pagination
let customerRows = [];
let oldestCustomerCursor = null;

// Bill pagination
let billRows = [];
let oldestBillCursor = null;

const $ = (id) => document.getElementById(id);

function normalizeMobile(value) {
  return String(value || "").replace(/\D/g, "").slice(-10);
}

function normalizeCar(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

function looksLikeMobile(value) {
  const digits = String(value || "").replace(/\D/g, "");
  return digits.length >= 7 && !/[A-Za-z]/.test(String(value || ""));
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function showToast(message, isError = false) {
  const toast = $("toast");
  toast.textContent = message;
  toast.classList.toggle("error", isError);
  toast.classList.add("show");

  clearTimeout(window.__toastTimer);
  window.__toastTimer = setTimeout(() => {
    toast.classList.remove("show");
  }, 2600);
}

function setDbStatus(text, type = "") {
  const el = $("dbStatus");
  el.className = `db-status ${type}`;
  el.querySelector("span:last-child").textContent = text;
}

function isFirebaseConfigured() {
  return !Object.values(firebaseConfig).some(v => String(v).includes("YOUR_"));
}

function formatDate(timestamp) {
  if (!timestamp) return "-";

  return new Date(timestamp).toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function initFirebase() {
  if (typeof firebase === "undefined") {
    setDbStatus("Firebase SDK failed to load", "error");
    showToast("Internet connection is required.", true);
    return;
  }

  if (!isFirebaseConfigured()) {
    setDbStatus("Add Firebase config in app.js");
    return;
  }

  try {
    if (!firebase.apps.length) {
      firebase.initializeApp(firebaseConfig);
    }

    db = firebase.database();

    db.ref(".info/connected").on("value", snapshot => {
      if (snapshot.val() === true) {
        setDbStatus("Firebase connected", "connected");
      } else {
        setDbStatus("Firebase offline / reconnecting");
      }
    });

  } catch (error) {
    console.error(error);
    setDbStatus("Firebase configuration error", "error");
  }
}

// ------------------------------------
// FAST INDEXED SEARCH
// ------------------------------------
async function getCustomerIdFromSearch(value) {
  if (!db) throw new Error("Firebase not initialized.");

  if (looksLikeMobile(value)) {
    const mobile = normalizeMobile(value);

    if (mobile.length !== 10) {
      return null;
    }

    const snapshot = await db.ref(`mobileIndex/${mobile}`).once("value");
    return snapshot.exists() ? snapshot.val() : null;
  }

  const car = normalizeCar(value);

  if (!car) return null;

  const snapshot = await db.ref(`carIndex/${car}`).once("value");
  return snapshot.exists() ? snapshot.val() : null;
}

async function getCustomer(customerId) {
  const snapshot = await db.ref(`customers/${customerId}`).once("value");

  if (!snapshot.exists()) return null;

  return {
    id: customerId,
    ...snapshot.val()
  };
}

async function runSearch() {
  if (!db) {
    showToast("First add Firebase configuration.", true);
    return;
  }

  const value = $("searchValue").value.trim();

  if (!value) {
    showToast("Enter Mobile No or Car No.", true);
    return;
  }

  try {
    const customerId = await getCustomerIdFromSearch(value);

    if (!customerId) {
      prepareNewCustomer(value);
      return;
    }

    const customer = await getCustomer(customerId);

    if (!customer) {
      showToast("Index exists but customer record is missing.", true);
      return;
    }

    await selectCustomer(customer);
    showToast("Existing customer found.");

  } catch (error) {
    console.error(error);
    showToast("Search failed. Check Firebase rules/config.", true);
  }
}

function prepareNewCustomer(searchValue = "") {
  currentCustomer = null;
  $("customerId").value = "";

  $("searchResult").className = "search-result empty-state";
  $("searchResult").textContent =
    "Customer not found. Fill details and save the first bill.";

  if (looksLikeMobile(searchValue)) {
    $("mobileNo").value = normalizeMobile(searchValue);
  } else {
    $("carNo").value = normalizeCar(searchValue);
  }

  resetBillHistory();
  showToast("New customer. Add details and save bill.");
}

async function selectCustomer(customer) {
  currentCustomer = customer;

  $("customerId").value = customer.id;
  $("mobileNo").value = customer.mobileNo || "";
  $("carNo").value = customer.latestCarNo || "";

  $("searchResult").className = "search-result";
  $("searchResult").innerHTML = `
    <div class="customer-summary">
      <div class="summary-row">
        <span>Mobile No</span>
        <span>${escapeHtml(customer.mobileNo || "-")}</span>
      </div>
      <div class="summary-row">
        <span>Latest Car No</span>
        <span>${escapeHtml(customer.latestCarNo || "-")}</span>
      </div>
      <div class="summary-row">
        <span>Customer Since</span>
        <span>${escapeHtml(formatDate(customer.createdAt))}</span>
      </div>
    </div>
  `;

  await loadLatestBills(customer.id);
}

// ------------------------------------
// SAVE CUSTOMER + BILL USING ATOMIC UPDATE
// ------------------------------------
async function saveBill(event) {
  event.preventDefault();

  if (!db) {
    showToast("First add Firebase configuration.", true);
    return;
  }

  const billNo = $("billNo").value.trim();
  const mobileNo = normalizeMobile($("mobileNo").value);
  const carNo = normalizeCar($("carNo").value);

  if (!billNo) {
    showToast("Enter Bill No.", true);
    return;
  }

  if (mobileNo.length !== 10) {
    showToast("Enter valid 10 digit Mobile No.", true);
    return;
  }

  if (!carNo) {
    showToast("Enter Car No.", true);
    return;
  }

  try {
    let customerId = $("customerId").value.trim();

    // No customer currently selected:
    // first try mobile index, then car index.
    if (!customerId) {
      const mobileSnap = await db.ref(`mobileIndex/${mobileNo}`).once("value");

      if (mobileSnap.exists()) {
        customerId = mobileSnap.val();
      } else {
        const carSnap = await db.ref(`carIndex/${carNo}`).once("value");

        if (carSnap.exists()) {
          customerId = carSnap.val();
        }
      }
    }

    const isNewCustomer = !customerId;

    if (isNewCustomer) {
      customerId = db.ref("customers").push().key;
    }

    let existingCustomer = null;

    if (!isNewCustomer) {
      existingCustomer = await getCustomer(customerId);
    }

    const now = Date.now();
    const billId = db.ref(`customerBills/${customerId}`).push().key;

    // One atomic multi-location update.
    const updates = {};

    updates[`customers/${customerId}/mobileNo`] = mobileNo;
    updates[`customers/${customerId}/latestCarNo`] = carNo;
    updates[`customers/${customerId}/updatedAt`] = now;

    if (!existingCustomer?.createdAt) {
      updates[`customers/${customerId}/createdAt`] = now;
    }

    // Maintain indexes.
    updates[`mobileIndex/${mobileNo}`] = customerId;
    updates[`carIndex/${carNo}`] = customerId;

    // Keep all car numbers ever used by this customer.
    updates[`customerCars/${customerId}/${carNo}`] = true;

    // Store bill separately from customer profile.
    updates[`customerBills/${customerId}/${billId}`] = {
      billNo,
      mobileNo,
      carNo,
      createdAt: now
    };

    await db.ref().update(updates);

    const freshCustomer = await getCustomer(customerId);
    await selectCustomer(freshCustomer);

    $("billNo").value = "";
    $("billNo").focus();

    showToast("Bill saved successfully.");

  } catch (error) {
    console.error(error);
    showToast("Unable to save bill. Check Firebase rules/config.", true);
  }
}

// ------------------------------------
// BILL HISTORY: 50 AT A TIME
// ------------------------------------
function resetBillHistory() {
  billRows = [];
  oldestBillCursor = null;

  $("historyCount").textContent = "0 Bills";
  $("billHistory").className = "history-list empty-state";
  $("billHistory").textContent = "No bill history selected.";
  $("loadOlderBillsBtn").classList.add("hidden");
}

async function loadLatestBills(customerId) {
  billRows = [];
  oldestBillCursor = null;

  const query = db.ref(`customerBills/${customerId}`)
    .orderByChild("createdAt")
    .limitToLast(BILL_PAGE_SIZE);

  const snapshot = await query.once("value");

  if (!snapshot.exists()) {
    resetBillHistory();
    return;
  }

  const rows = [];
  snapshot.forEach(child => {
    rows.push({
      id: child.key,
      ...child.val()
    });
  });

  rows.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

  billRows = rows;

  const oldest = rows[rows.length - 1];
  oldestBillCursor = oldest
    ? { createdAt: oldest.createdAt || 0, key: oldest.id }
    : null;

  renderBillRows();

  $("loadOlderBillsBtn").classList.toggle(
    "hidden",
    rows.length < BILL_PAGE_SIZE
  );
}

async function loadOlderBills() {
  if (!currentCustomer?.id || !oldestBillCursor) return;

  try {
    const query = db.ref(`customerBills/${currentCustomer.id}`)
      .orderByChild("createdAt")
      .endAt(oldestBillCursor.createdAt, oldestBillCursor.key)
      .limitToLast(BILL_PAGE_SIZE + 1);

    const snapshot = await query.once("value");

    const rows = [];

    snapshot.forEach(child => {
      if (child.key === oldestBillCursor.key) return;

      rows.push({
        id: child.key,
        ...child.val()
      });
    });

    rows.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

    if (!rows.length) {
      $("loadOlderBillsBtn").classList.add("hidden");
      showToast("No older bills.");
      return;
    }

    billRows = [...billRows, ...rows];

    const oldest = rows[rows.length - 1];
    oldestBillCursor = oldest
      ? { createdAt: oldest.createdAt || 0, key: oldest.id }
      : null;

    renderBillRows();

    if (rows.length < BILL_PAGE_SIZE) {
      $("loadOlderBillsBtn").classList.add("hidden");
    }

  } catch (error) {
    console.error(error);
    showToast("Unable to load older bills.", true);
  }
}

function renderBillRows() {
  const history = $("billHistory");

  $("historyCount").textContent =
    `${billRows.length} Loaded`;

  if (!billRows.length) {
    history.className = "history-list empty-state";
    history.textContent = "No bills found.";
    return;
  }

  history.className = "history-list";

  history.innerHTML = billRows.map((bill, index) => `
    <div class="bill-item">
      <div class="bill-main">
        <strong>${escapeHtml(bill.billNo || "-")}</strong>
        <span>${index === 0 ? "Latest bill" : "Saved bill"}</span>
      </div>

      <div class="bill-meta">
        <strong>${escapeHtml(bill.carNo || "-")}</strong>
        <span>Car No</span>
      </div>

      <div class="bill-meta">
        <strong>${escapeHtml(formatDate(bill.createdAt))}</strong>
        <span>Bill Date</span>
      </div>

      <span class="bill-tag">
        ${index === 0 ? "NEWEST" : "SAVED"}
      </span>
    </div>
  `).join("");
}

// ------------------------------------
// CUSTOMER LIST: 50 AT A TIME
// ------------------------------------
async function loadLatestCustomers() {
  if (!db) {
    showToast("First add Firebase configuration.", true);
    return;
  }

  customerRows = [];
  oldestCustomerCursor = null;

  $("customerTableBody").innerHTML =
    `<tr><td colspan="4" class="table-empty">Loading...</td></tr>`;

  try {
    const query = db.ref("customers")
      .orderByChild("updatedAt")
      .limitToLast(CUSTOMER_PAGE_SIZE);

    const snapshot = await query.once("value");

    if (!snapshot.exists()) {
      renderCustomerTable();
      return;
    }

    const rows = [];

    snapshot.forEach(child => {
      rows.push({
        id: child.key,
        ...child.val()
      });
    });

    rows.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

    customerRows = rows;

    const oldest = rows[rows.length - 1];
    oldestCustomerCursor = oldest
      ? { updatedAt: oldest.updatedAt || 0, key: oldest.id }
      : null;

    renderCustomerTable();

    $("loadOlderCustomersBtn").classList.toggle(
      "hidden",
      rows.length < CUSTOMER_PAGE_SIZE
    );

  } catch (error) {
    console.error(error);

    $("customerTableBody").innerHTML =
      `<tr><td colspan="4" class="table-empty">Unable to load customers.</td></tr>`;

    showToast(
      "Customer list failed. Add updatedAt index in database rules.",
      true
    );
  }
}

async function loadOlderCustomers() {
  if (!oldestCustomerCursor) return;

  try {
    const query = db.ref("customers")
      .orderByChild("updatedAt")
      .endAt(oldestCustomerCursor.updatedAt, oldestCustomerCursor.key)
      .limitToLast(CUSTOMER_PAGE_SIZE + 1);

    const snapshot = await query.once("value");
    const rows = [];

    snapshot.forEach(child => {
      if (child.key === oldestCustomerCursor.key) return;

      rows.push({
        id: child.key,
        ...child.val()
      });
    });

    rows.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

    if (!rows.length) {
      $("loadOlderCustomersBtn").classList.add("hidden");
      showToast("No older customers.");
      return;
    }

    customerRows = [...customerRows, ...rows];

    const oldest = rows[rows.length - 1];
    oldestCustomerCursor = oldest
      ? { updatedAt: oldest.updatedAt || 0, key: oldest.id }
      : null;

    renderCustomerTable();

    if (rows.length < CUSTOMER_PAGE_SIZE) {
      $("loadOlderCustomersBtn").classList.add("hidden");
    }

  } catch (error) {
    console.error(error);
    showToast("Unable to load older customers.", true);
  }
}

function renderCustomerTable() {
  const tbody = $("customerTableBody");

  $("customerPageInfo").textContent =
    `${customerRows.length} customer${customerRows.length === 1 ? "" : "s"} loaded`;

  if (!customerRows.length) {
    tbody.innerHTML =
      `<tr><td colspan="4" class="table-empty">No customers found.</td></tr>`;
    return;
  }

  tbody.innerHTML = customerRows.map(customer => `
    <tr>
      <td>${escapeHtml(customer.mobileNo || "-")}</td>
      <td>${escapeHtml(customer.latestCarNo || "-")}</td>
      <td>${escapeHtml(formatDate(customer.updatedAt))}</td>
      <td>
        <button
          class="link-btn open-customer"
          data-id="${escapeHtml(customer.id)}"
        >
          Open
        </button>
      </td>
    </tr>
  `).join("");

  document.querySelectorAll(".open-customer").forEach(button => {
    button.addEventListener("click", async () => {
      try {
        const customer = await getCustomer(button.dataset.id);

        if (!customer) {
          showToast("Customer not found.", true);
          return;
        }

        switchView("entryView");
        $("searchValue").value = customer.mobileNo || "";
        await selectCustomer(customer);

      } catch (error) {
        console.error(error);
        showToast("Unable to open customer.", true);
      }
    });
  });
}

// ------------------------------------
// UI
// ------------------------------------
function clearForm() {
  currentCustomer = null;

  $("billForm").reset();
  $("customerId").value = "";
  $("searchValue").value = "";

  $("searchResult").className = "search-result empty-state";
  $("searchResult").textContent = "No customer selected.";

  resetBillHistory();
}

function switchView(viewId) {
  document.querySelectorAll(".view").forEach(view => {
    view.classList.remove("active-view");
  });

  document.querySelectorAll(".nav-item").forEach(item => {
    item.classList.remove("active");
  });

  $(viewId).classList.add("active-view");

  const nav = document.querySelector(`.nav-item[data-view="${viewId}"]`);
  if (nav) nav.classList.add("active");

  if (viewId === "customersView") {
    loadLatestCustomers();
  }
}

document.addEventListener("DOMContentLoaded", () => {
  $("billForm").addEventListener("submit", saveBill);
  $("searchBtn").addEventListener("click", runSearch);
  $("clearBtn").addEventListener("click", clearForm);
  $("refreshBtn").addEventListener("click", loadLatestCustomers);
  $("loadOlderCustomersBtn").addEventListener("click", loadOlderCustomers);
  $("loadOlderBillsBtn").addEventListener("click", loadOlderBills);

  $("searchValue").addEventListener("keydown", event => {
    if (event.key === "Enter") {
      event.preventDefault();
      runSearch();
    }
  });

  document.querySelectorAll(".nav-item").forEach(button => {
    button.addEventListener("click", () => {
      switchView(button.dataset.view);
    });
  });

  initFirebase();
});
