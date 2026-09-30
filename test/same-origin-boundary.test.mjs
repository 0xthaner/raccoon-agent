/**
 * AGENT-SEC-W2: Welche Herkunft als die eigene gilt.
 *
 * `requireSameOrigin` verglich die `Origin` des Requests gegen einen Erwartungs-
 * wert, der bei fehlendem `APP_BASE_URL` aus dem `Host`-Header gebaut wurde. Aus
 * dem Browser war das nicht ausnutzbar - der Browser setzt `Host` selbst auf das
 * echte Ziel -, aber es war eine Vertrauensquelle aus dem Request. Diese Tests
 * halten fest, dass es sie nicht mehr gibt.
 *
 * Deterministisch und offline: kein Netzwerk, keine Datenbank.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { requireSameOrigin } from '../src/http-security.mjs';
import { PRODUCTION_ORIGIN, siweOrigin } from '../src/siwe-auth.mjs';

function withEnv(values, run) {
	const previous = {};
	for (const [key, value] of Object.entries(values)) {
		previous[key] = process.env[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	try {
		return run();
	} finally {
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

function inProduction(run) {
	return withEnv({ APP_BASE_URL: PRODUCTION_ORIGIN, NODE_ENV: undefined, VERCEL_ENV: 'production' }, run);
}

/** Minimale Antwort, die nur festhaelt, was ihr gesagt wurde. */
function fakeResponse() {
	const gesehen = { status: null, body: null };
	return {
		gesehen,
		status(code) { gesehen.status = code; return this; },
		json(body) { gesehen.body = body; return this; }
	};
}

function anfrage(headers) {
	return { headers };
}

test('W2 die eigene Origin wird durchgelassen', () => {
	inProduction(() => {
		const response = fakeResponse();
		assert.equal(requireSameOrigin(anfrage({ origin: PRODUCTION_ORIGIN, host: 'agent.coverraccoon.com' }), response), true);
		assert.equal(response.gesehen.status, null);
	});
});

test('W2 eine fremde Origin faellt', () => {
	inProduction(() => {
		const response = fakeResponse();
		assert.equal(requireSameOrigin(anfrage({ origin: 'https://evil.example', host: 'agent.coverraccoon.com' }), response), false);
		assert.equal(response.gesehen.status, 403);
	});
});

test('W2 der Host-Header bestimmt die Erwartung nicht mehr', () => {
	// Genau der Fall, den der alte Rueckfall durchgelassen haette: Origin und
	// Host stimmen ueberein, beide sind aber nicht die konfigurierte Adresse.
	inProduction(() => {
		const response = fakeResponse();
		assert.equal(requireSameOrigin(anfrage({ origin: 'https://angreifer.example', host: 'angreifer.example' }), response), false);
		assert.equal(response.gesehen.status, 403);
	});
});

test('W2 ohne Konfiguration gibt es keinen Rueckfall, sondern 503', () => {
	withEnv({ APP_BASE_URL: undefined, NODE_ENV: undefined, VERCEL_ENV: 'production' }, () => {
		const response = fakeResponse();
		assert.equal(requireSameOrigin(anfrage({ origin: 'https://agent.coverraccoon.com', host: 'agent.coverraccoon.com' }), response), false);
		assert.equal(response.gesehen.status, 503);
		assert.equal(response.gesehen.body.ok, false);
	});
});

test('W2 eine cross-site Anfrage faellt vor jeder Originpruefung', () => {
	inProduction(() => {
		const response = fakeResponse();
		assert.equal(requireSameOrigin(anfrage({ 'sec-fetch-site': 'cross-site', origin: PRODUCTION_ORIGIN }), response), false);
		assert.equal(response.gesehen.status, 403);
	});
});

test('W2 ohne Origin und ohne sec-fetch-site traegt das Cookie die Grenze', () => {
	// Dokumentiert bewusst den bestehenden Zustand: alte Clients ohne beide
	// Header kommen durch; abgesichert ist das ueber SameSite=Strict.
	inProduction(() => {
		const response = fakeResponse();
		assert.equal(requireSameOrigin(anfrage({}), response), true);
		assert.equal(response.gesehen.status, null);
	});
});

test('W2 die Funktion liest den Host-Header nirgends mehr', () => {
	const quelle = readFileSync(new URL('../src/http-security.mjs', import.meta.url), 'utf8');
	/*
		Das `[^:]` vor dem Doppelschraegstrich ist nicht Kosmetik: ohne es haelt der
		Filter das `//` in `https://` fuer einen Zeilenkommentar und loescht den Rest
		der Zeile - also genau den Ausdruck, um den es hier geht. Diese Pruefung war
		damit zuerst blind und ist erst in der Gegenprobe aufgefallen. Dasselbe
		Muster steht in `scripts/check-frontend.mjs`.
	*/
	const code = quelle
		.replace(/\/\*[\s\S]*?\*\//g, (treffer) => treffer.replace(/[^\n]/g, ' '))
		.replace(/(^|[^:])\/\/[^\n]*/g, (treffer, vor) => vor + ' '.repeat(treffer.length - vor.length));
	assert.equal(code.includes('headers.host'), false);
	assert.equal(code.includes('headers[\'host\']'), false);
	// Die Rate-Limit-Identitaet darf `x-forwarded-for` weiterhin lesen - sie
	// authentifiziert nichts, sie zaehlt nur.
	assert.ok(code.includes('x-forwarded-for'));
});

test('W2 eine Vercel-Preview gilt weiterhin als Production', () => {
	// `preview` ist kein Entwicklungssignal. Ohne eigene Konfiguration gibt es
	// dort keine gueltige Anmeldedomain - fail closed, kein stiller Rueckfall.
	withEnv({ APP_BASE_URL: 'http://localhost:8787', NODE_ENV: undefined, VERCEL_ENV: 'preview' }, () => {
		assert.throws(() => siweOrigin());
	});
	withEnv({ APP_BASE_URL: 'http://localhost:8787', NODE_ENV: undefined, VERCEL_ENV: 'development' }, () => {
		assert.equal(siweOrigin().uri, 'http://localhost:8787');
	});
});
