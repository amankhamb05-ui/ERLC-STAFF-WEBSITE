let currentUser = null;

/* =========================
   LOAD USER
========================= */

async function loadUser() {

    const response = await fetch("/api/me");

    if (!response.ok) {
        window.location.href = "/";
        return;
    }

    currentUser = await response.json();

    document.getElementById("username").textContent =
        currentUser.username;

    if (currentUser.isSupervisor) {
        document.getElementById(
            "supervisorSection"
        ).style.display = "block";

        loadLOAs();
    }

    if (currentUser.isManagement) {
        document.getElementById(
            "managementSection"
        ).style.display = "block";

        loadPunishments();
    }

    checkShift();
}

/* =========================
   SHIFT
========================= */

async function checkShift() {

    const response = await fetch("/api/shifts");

    if (!response.ok) return;

    const shifts = await response.json();

    const active = shifts.find(
        shift => !shift.ended_at
    );

    const status =
        document.getElementById("shiftStatus");

    if (active) {

        status.innerHTML =
            `<span class="success">
                🟢 You are currently on shift.
            </span>`;

    } else {

        status.textContent =
            "You are currently off shift.";

    }
}

async function startShift() {

    const response = await fetch(
        "/api/shifts/start",
        {
            method: "POST"
        }
    );

    const data = await response.json();

    if (!response.ok) {
        alert(data.error);
        return;
    }

    alert("Shift started!");

    checkShift();
}

async function endShift() {

    const response = await fetch(
        "/api/shifts/end",
        {
            method: "POST"
        }
    );

    const data = await response.json();

    if (!response.ok) {
        alert(data.error);
        return;
    }

    alert("Shift ended!");

    checkShift();
}

/* =========================
   LOA
========================= */

document
    .getElementById("loaForm")
    .addEventListener("submit", async event => {

        event.preventDefault();

        const reason =
            document.getElementById("loaReason").value;

        const startDate =
            document.getElementById("loaStart").value;

        const endDate =
            document.getElementById("loaEnd").value;

        const response = await fetch(
            "/api/loa",
            {
                method: "POST",

                headers: {
                    "Content-Type": "application/json"
                },

                body: JSON.stringify({
                    reason,
                    startDate,
                    endDate
                })
            }
        );

        const data = await response.json();

        if (!response.ok) {
            alert(data.error);
            return;
        }

        alert("LOA submitted!");

        event.target.reset();

        if (currentUser.isSupervisor) {
            loadLOAs();
        }
    });

async function loadLOAs() {

    const container =
        document.getElementById("loaRequests");

    const response =
        await fetch("/api/loa");

    if (!response.ok) {
        container.textContent =
            "Unable to load LOAs.";

        return;
    }

    const loas = await response.json();

    if (loas.length === 0) {

        container.textContent =
            "No LOA requests.";

        return;
    }

    container.innerHTML = "";

    loas.forEach(loa => {

        const div =
            document.createElement("div");

        div.className = "request";

        div.innerHTML = `
            <strong>${escapeHTML(loa.username)}</strong>

            <p>
                <strong>Reason:</strong>
                ${escapeHTML(loa.reason)}
            </p>

            <p>
                <strong>Dates:</strong>
                ${loa.start_date}
                →
                ${loa.end_date}
            </p>

            <p>
                <strong>Status:</strong>
                ${loa.status}
            </p>

            ${
                loa.status === "pending"
                ? `
                    <div class="request-buttons">

                        <button
                            onclick="approveLOA(${loa.id})"
                        >
                            Approve
                        </button>

                        <button
                            class="danger"
                            onclick="denyLOA(${loa.id})"
                        >
                            Deny
                        </button>

                    </div>
                `
                : ""
            }
        `;

        container.appendChild(div);
    });
}

async function approveLOA(id) {

    await fetch(
        `/api/loa/${id}/approve`,
        {
            method: "POST"
        }
    );

    loadLOAs();
}

async function denyLOA(id) {

    await fetch(
        `/api/loa/${id}/deny`,
        {
            method: "POST"
        }
    );

    loadLOAs();
}

/* =========================
   PUNISHMENTS
========================= */

document
    .getElementById("punishmentForm")
    .addEventListener("submit", async event => {

        event.preventDefault();

        const userId =
            document.getElementById(
                "punishmentUserId"
            ).value;

        const username =
            document.getElementById(
                "punishmentUsername"
            ).value;

        const punishmentType =
            document.getElementById(
                "punishmentType"
            ).value;

        const reason =
            document.getElementById(
                "punishmentReason"
            ).value;

        const response = await fetch(
            "/api/punishments",
            {
                method: "POST",

                headers: {
                    "Content-Type": "application/json"
                },

                body: JSON.stringify({
                    userId,
                    username,
                    punishmentType,
                    reason
                })
            }
        );

        const data = await response.json();

        if (!response.ok) {
            alert(data.error);
            return;
        }

        alert("Punishment logged!");

        event.target.reset();

        if (currentUser.isManagement) {
            loadPunishments();
        }
    });

async function loadPunishments() {

    const container =
        document.getElementById(
            "punishmentHistory"
        );

    const response =
        await fetch("/api/punishments");

    if (!response.ok) {
        container.textContent =
            "Unable to load punishment records.";

        return;
    }

    const records =
        await response.json();

    if (records.length === 0) {

        container.textContent =
            "No punishment records.";

        return;
    }

    container.innerHTML = "";

    records.forEach(record => {

        const div =
            document.createElement("div");

        div.className = "record";

        div.innerHTML = `
            <strong>
                ${escapeHTML(record.username)}
            </strong>

            <p>
                <strong>Type:</strong>
                ${escapeHTML(record.punishment_type)}
            </p>

            <p>
                <strong>Reason:</strong>
                ${escapeHTML(record.reason)}
            </p>

            <p>
                <strong>Issued by:</strong>
                ${escapeHTML(record.issued_by)}
            </p>

            <p>
                ${new Date(
                    record.created_at
                ).toLocaleString()}
            </p>
        `;

        container.appendChild(div);
    });
}

/* =========================
   SECURITY
========================= */

function escapeHTML(value) {

    const div =
        document.createElement("div");

    div.textContent =
        value ?? "";

    return div.innerHTML;
}

/* =========================
   START
========================= */

loadUser();
