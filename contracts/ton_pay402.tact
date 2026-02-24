import "@stdlib/deploy";

// Message to trigger a payment by the AI Agent
message ExecutePayment {
    amount: Int as coins;
    target: Address;
}

// Message to update spending policies by the human owner
message UpdateSettings {
    newLimit: Int as coins;
}

// Message to add/remove a target from the trusted whitelist
message(0xdf66564c) UpdateWhitelist {
    target: Address;
    allowed: Bool;
}

// Owner-only emergency controls
message(0x6d273de6) EmergencyStop {}
message(0x279f1b5d) ResumeOperations {}

// Event emitted when a transaction exceeds the limit and needs human eyes
message(0xd039daef) ApprovalRequest {
    amount: Int as coins;
    target: Address;
}

contract TonPay402 {
    owner: Address;           // The human supervisor
    agent: Address;           // The authorized AI agent
    dailyLimit: Int as coins; // Max amount allowed per 24h
    spentToday: Int as coins; // Tracking current usage
    lastReset: Int as uint32; // Timestamp of the last limit reset
    whitelist: map<Address, Bool>; // Trusted recipients for unrestricted agent payments
    emergencyStopped: Bool; // If true, agent payment execution is suspended

    init(owner: Address, agent: Address, initialLimit: Int) {
        self.owner = owner;
        self.agent = agent;
        self.dailyLimit = initialLimit;
        self.spentToday = 0;
        self.lastReset = now(); // Initialized with deployment time
        self.whitelist = emptyMap();
        self.emergencyStopped = false;
    }

    // Internal function to check and reset the daily allowance if 24 hours passed
    fun checkAndResetLimit() {
        if (now() >= self.lastReset + 86400) { // 86400 seconds = 24 hours
            self.spentToday = 0;
            self.lastReset = now();
        }
    }

    // Empty receiver for deployment and value top-ups.
    receive() {
        cashback(sender());
    }

    // Management: Owner can pause all agent-initiated payment execution
    receive(msg: EmergencyStop) {
        require(sender() == self.owner, "Access Denied: Only owner can trigger emergency stop");
        self.emergencyStopped = true;
    }

    // Management: Owner can resume agent-initiated payment execution
    receive(msg: ResumeOperations) {
        require(sender() == self.owner, "Access Denied: Only owner can resume operations");
        self.emergencyStopped = false;
    }

    // Logic to handle payment requests from the Agent
    receive(msg: ExecutePayment) {
        let isOwner = sender() == self.owner;
        let isAgent = sender() == self.agent;

        // 0. Access control: only the agent or owner can execute payments
        require(isAgent || isOwner, "Access Denied: Only agent or owner can execute payments");
        require(msg.amount > 0, "Invalid amount");
        require(!isAgent || !self.emergencyStopped, "Emergency Stop Active: Agent payments are paused");

        // 1. Refresh the daily allowance state
        self.checkAndResetLimit();

        let isWhitelisted = self.whitelist.get(msg.target) != null;

        // 2. Non-whitelisted targets follow normal policy controls.
        if (!isWhitelisted) {
            // Manual approval flow: agent cannot exceed limit directly.
            // Owner can submit the same payment manually after out-of-band approval.
            if (isAgent && self.spentToday + msg.amount > self.dailyLimit) {
                // Emit event for off-chain listeners (e.g. Telegram bot bridge)
                emit(ApprovalRequest{amount: msg.amount, target: msg.target}.toCell());
                self.reply("Policy Limit Reached: Approval request emitted".asComment());
                return;
            }

            // 3. Update tracked spend for policy-limited targets
            self.spentToday += msg.amount;
        }

        // 4. Execute the transfer on TON 
        send(SendParameters{
            to: msg.target,
            value: msg.amount,
            mode: SendIgnoreErrors,
            body: "M2M Payment via TonPay402".asComment()
        });

        // 5. Notify the caller about success
        self.reply("Payment authorized and executed".asComment());
    }

    // Management: Only the human owner can change limits 
    receive(msg: UpdateSettings) {
        require(sender() == self.owner, "Access Denied: Only owner can update settings");
        self.dailyLimit = msg.newLimit;
    }

    // Management: Owner can add/remove trusted recipients from whitelist
    receive(msg: UpdateWhitelist) {
        require(sender() == self.owner, "Access Denied: Only owner can update whitelist");

        if (msg.allowed) {
            self.whitelist.set(msg.target, true);
        } else {
            self.whitelist.set(msg.target, null);
        }
    }

    // GETTER: Used by AI Agent or UI to check how much it can still spend 
    get fun remaining_allowance(): Int {
        if (now() >= self.lastReset + 86400) {
            return self.dailyLimit;
        }
        return self.dailyLimit - self.spentToday;
    }

    get fun daily_limit(): Int {
        return self.dailyLimit;
    }

    get fun is_whitelisted(target: Address): Bool {
        return self.whitelist.get(target) != null;
    }

    get fun emergency_status(): Bool {
        return self.emergencyStopped;
    }
}