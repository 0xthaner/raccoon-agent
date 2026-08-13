const token = new URLSearchParams(location.search).get('token');
const preview = new URLSearchParams(location.search).get('preview') === '1';
const status = document.querySelector('#status');
const injected = document.querySelector('#injected');
const walletconnect = document.querySelector('#walletconnect');
const confirm = document.querySelector('#confirm');
const consent = document.querySelector('#consent');
let wallet = '';
let appKit;
let appKitReady;
let walletProvider;
let phase = 'approve';
let expectedWallet = '';

const show = (text) => { status.textContent = text; };
const step = (number) => document.querySelectorAll('.step').forEach((el, i) => el.classList.toggle('active', i <= number - 1));

async function load() {
	if (!token && !preview) throw new Error('Checkout-Link fehlt. Öffne die Verlängerung erneut in Telegram.');
	const response = await fetch(preview ? '/api/demo-renew?preview=1' : `/api/demo-renew?token=${encodeURIComponent(token)}`);
	const data = await response.json();
	if (!data.ok) throw new Error(data.error);
	const r = data.renewal;
	expectedWallet = r.wallet.toLowerCase();
	document.querySelector('#product').textContent = r.productName;
	document.querySelector('#cover').textContent = `Cover #${r.coverId}`;
	document.querySelector('#amount').textContent = r.amount;
	document.querySelector('#period').textContent = `${r.periodDays} Tage`;
	document.querySelector('#premium').textContent = r.nexusPremium;
	document.querySelector('#commission').textContent = r.commission;
	document.querySelector('#maximum').textContent = r.maximum;
	if (preview) {
		document.querySelector('.actions').hidden = true;
		document.querySelector('.consent').hidden = true;
		document.querySelector('.pill').textContent = 'Vorschau';
		show('Vorschau des Verlängerungsablaufs · keine Wallet-Verbindung oder Transaktion möglich.');
		return;
	}
	show('Demo: Verbinde die Owner-Wallet. Anschließend werden zwei Signaturen simuliert – keine Transaktionen.');
}

async function connected(address, provider) {
	if (address.toLowerCase() !== expectedWallet) throw new Error('Das ist nicht die Owner-Wallet dieses Covers. Bitte verbinde 0x59ED…c2b1.');
	wallet = address;
	walletProvider = provider;
	try {
		await walletProvider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x1' }] });
	} catch { throw new Error('Bitte stelle deine Wallet auf Ethereum Mainnet um.'); }
	injected.hidden = true;
	walletconnect.hidden = true;
	confirm.hidden = false;
	confirm.disabled = !consent.checked;
	step(2);
	show(`Owner-Wallet bestätigt: ${address.slice(0, 6)}…${address.slice(-4)} · Als Nächstes wird nur die Freigabe-Signatur simuliert.`);
}

consent.addEventListener('change', () => { confirm.disabled = !consent.checked || !wallet; });
injected.addEventListener('click', async () => {
	try {
		if (window.ethereum) {
			show('Wallet wird verbunden …'); step(2);
			const [address] = await window.ethereum.request({ method: 'eth_requestAccounts' });
			await connected(address, window.ethereum);
			return;
		}
		await appKitReady;
		await connectViaAppKit();
	} catch (error) { show(error.message); }
});

async function connectViaAppKit() {
	if (!appKit) throw new Error('WalletConnect wird noch geladen. Bitte versuche es gleich erneut.');
	const current = appKit.getAddress?.('eip155');
	const currentProvider = appKit.getWalletProvider();
	if (current && currentProvider) {
		await connected(current, currentProvider);
		return;
	}
	show('Wallet-Auswahl wird geöffnet …'); step(2);
	const accountPromise = new Promise((resolve, reject) => {
		const timeout = setTimeout(() => reject(new Error('Wallet-Verbindung hat zu lange gedauert.')), 120000);
		let unsubscribe = () => {};
		unsubscribe = appKit.subscribeAccount((state) => {
			if (state.isConnected && state.address) { clearTimeout(timeout); unsubscribe(); resolve(state.address); }
		}, 'eip155');
	});
	await appKit.open();
	const address = await accountPromise;
	const provider = appKit.getWalletProvider();
	if (!provider) throw new Error('WalletConnect-Provider fehlt.');
	await appKit.close();
	await connected(address, provider);
}

async function setupWalletConnect() {
	const [{ createAppKit }, { EthersAdapter }, { mainnet }] = await Promise.all([import('@reown/appkit'), import('@reown/appkit-adapter-ethers'), import('@reown/appkit/networks')]);
	const config = await fetch('/api/config').then((r) => r.json());
	if (!config.reownProjectId) { walletconnect.disabled = true; return; }
	appKit = createAppKit({ adapters: [new EthersAdapter()], networks: [mainnet], projectId: config.reownProjectId, metadata: { name: 'Raccoon Agent', description: 'Personal DeFi cover renewal', url: location.origin, icons: [] }, features: { analytics: false, email: false, socials: [] } });
	walletconnect.addEventListener('click', async () => {
		try {
			await connectViaAppKit();
		} catch (error) { show(error.message); }
	});
}

confirm.addEventListener('click', async () => {
	try {
		confirm.disabled = true;
		if (phase === 'approve') {
			step(3); show('Simulation 1/2: Signiere die Demo-Nachricht. Es wird keine echte USDC-Freigabe erzeugt.');
			await walletProvider.request({ method: 'personal_sign', params: ['Raccoon Agent Demo\n\nSchritt 1/2: USDC-Freigabe an Nexus CoverBroker simulieren.\nKeine Tokenfreigabe und keine Transaktion.', wallet] });
			phase = 'buy'; confirm.textContent = 'Verlängerung simulieren · 2/2'; confirm.disabled = false;
			show('Freigabe-Simulation signiert. Als Nächstes simulierst du den buyCover-Abschluss – weiterhin ohne Transaktion.');
			return;
		}
		step(4); show('Simulation 2/2: Signiere den beispielhaften buyCover-Abschluss. Es wird nichts gekauft oder bezahlt.');
		await walletProvider.request({ method: 'personal_sign', params: ['Raccoon Agent Demo\n\nSchritt 2/2: Nexus buyCover für Cover #424242 simulieren.\nMaximal 124,87 USDC · 5 % Coverraccoon-Provision.\nKeine Zahlung und keine Transaktion.', wallet] });
		show('Demo-Signatur erhalten. Der simulierte Abschluss wird dargestellt …');
		await new Promise((resolve) => setTimeout(resolve, 1100));
		const response = await fetch('/api/demo-renew', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token, wallet }) });
		const data = await response.json();
		if (!data.ok) throw new Error(data.error);
		step(5); document.querySelector('#checkout').hidden = true; document.querySelector('#success').classList.add('show');
	} catch (error) { confirm.disabled = false; show(error.message); }
});

load().catch((error) => { show(error.message); injected.disabled = true; walletconnect.disabled = true; });
appKitReady = preview ? Promise.resolve() : setupWalletConnect().catch((error) => { walletconnect.disabled = true; walletconnect.title = error.message; throw error; });
