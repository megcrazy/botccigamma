
import fetch from "node-fetch";
import technicalindicators from "technicalindicators";
import fs from "fs";

// === CONFIGURAÇÕES ===
const TELEGRAM_BOT_TOKEN = ""; // Seu Bot Token
const TELEGRAM_CHAT_ID = "-1002545603959"; // Seu Chat ID
const JSON_FILE = "gamma_levels_btc.json";
const STRIKE_RANGE_0DTE = 0.1; // ±10% do spot para 0DTE
const STRIKE_RANGE_FUTURE = 0.3; // ±30% do spot para futuras
const MAX_RETRIES = 3; // Reduzido para evitar longos tempos de espera
const RETRY_DELAY = 1000; // 1 segundo entre retries
const REQUEST_DELAY = 50; // 50ms entre requisições
const BATCH_SIZE = 20; // Processar 20 tickers por vez
const TIMEOUT = 30000; // 30 segundos de timeout por requisição

// Função para enviar mensagem no Telegram
async function sendTelegramMessage(message) {
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        try {
            const response = await fetch(url, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    chat_id: TELEGRAM_CHAT_ID,
                    text: message,
                    parse_mode: "Markdown"
                }),
                timeout: TIMEOUT
            });
            const result = await response.json();
            if (!result.ok) {
                console.error("❌ Erro na API do Telegram:", result);
            } else {
                console.log("✅ Mensagem enviada para o Telegram!");
                return;
            }
        } catch (e) {
            console.error(`🚫 Tentativa ${attempt + 1}/${MAX_RETRIES} - Erro ao enviar para Telegram: ${e.message}`);
        }
        if (attempt < MAX_RETRIES - 1) await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
    }
    console.error("🚫 Falha ao enviar mensagem após todas as tentativas");
}

// Função para buscar velas da Binance
async function getCandles(symbol, interval, limit = 25) {
    try {
        const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
        const response = await fetch(url, { timeout: TIMEOUT });
        const data = await response.json();
        if (data.code && data.msg) {
            console.error(`❌ Erro ao buscar velas da Binance para ${symbol}-${interval}: ${data.msg}`);
            return [];
        }
        return data.map(c => ({
            high: parseFloat(c[2]),
            low: parseFloat(c[3]),
            close: parseFloat(c[4])
        }));
    } catch (e) {
        console.error(`🚫 Erro ao buscar velas da Binance para ${symbol}-${interval}: ${e.message}`);
        return [];
    }
}

// Função para calcular CCI
function calculateCCI(candles, period = 20) {
    if (!candles || candles.length === 0) return "N/A";
    const input = {
        high: candles.map(c => c.high),
        low: candles.map(c => c.low),
        close: candles.map(c => c.close),
        period
    };
    const result = technicalindicators.CCI.calculate(input);
    return result[result.length - 1]?.toFixed(2) || "N/A";
}

// Função para interpretar o CCI
function interpretCCI(cci) {
    if (cci >= 250) return "🟢 Sobrecompra → topo próximo";
    if (cci > 100) return "🔵 Alta forte";
    if (cci > 0) return "🟡 Alta moderada";
    if (cci > -100) return "⚪ Neutro / Fraca queda";
    if (cci > -250) return "🟣 Queda iniciando";
    if (cci <= -250) return "🔴 Sobrevenda → fundo próximo";
    return "🪫 Indefinido";
}

// Função para obter timestamp em meia-noite
function getMidnightTimestamp(date) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

// Função para carregar último JSON salvo
function loadLastJson() {
    try {
        if (fs.existsSync(JSON_FILE)) {
            const data = JSON.parse(fs.readFileSync(JSON_FILE, "utf8"));
            if (data.btc && ["call_wall", "put_wall", "gamma_flip", "call_wall_0dte", "put_wall_0dte"].every(key => key in data.btc)) {
                console.log("✅ JSON anterior carregado:", data);
                return data;
            }
        }
    } catch (e) {
        console.warn("⚠️ Falha ao carregar JSON:", e.message);
    }
    return null;
}

// Função para salvar resultado em JSON
function saveJson(result) {
    try {
        fs.writeFileSync(JSON_FILE, JSON.stringify(result, null, 2));
        console.log(`✅ Resultado salvo em ${JSON_FILE}`);
    } catch (e) {
        console.error(`❌ Erro ao salvar JSON: ${e.message}`);
    }
}

// Função para buscar opções da Bybit (fallback)
async function getBybitOptions(spotPrice) {
    try {
        const url = "https://api.bybit.com/v5/market/instruments-info?category=option&symbol=BTC";
        const response = await fetch(url, { timeout: TIMEOUT });
        const data = await response.json();
        if (!data.result?.list) {
            console.warn("⚠️ Nenhuma opção encontrada na Bybit.");
            return [];
        }
        return data.result.list
            .map(item => ({
                instrument_name: item.symbol,
                strike: parseFloat(item.strikePrice),
                open_interest: parseFloat(item.openInterest) || 0,
                option_type: item.optionType.toLowerCase(),
                expiry: new Date(item.expiryDate).getTime(),
                mark_iv: 0.5 // Default IV
            }))
            .filter(option => {
                if (!spotPrice) return true;
                const range = STRIKE_RANGE_FUTURE * spotPrice;
                return Math.abs(option.strike - spotPrice) <= range;
            });
    } catch (e) {
        console.error("🚫 Erro ao buscar opções da Bybit:", e.message);
        return [];
    }
}

// Função para estimar Gamma (simplificado)
function estimateGamma(spot, strike, timeToExpiry, volatility) {
    if (timeToExpiry <= 0) timeToExpiry = 1 / 365;
    const d1 = (Math.log(spot / strike) + (0.01 + (volatility ** 2) / 2) * timeToExpiry) / (volatility * Math.sqrt(timeToExpiry));
    const gamma = (Math.exp(-(d1 ** 2) / 2) / (spot * volatility * Math.sqrt(2 * Math.PI * timeToExpiry))) * 100;
    return isFinite(gamma) ? gamma : 0;
}

// Função para buscar ticker com retries
async function fetchTickerWithRetry(instrumentName) {
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        try {
            const response = await fetch(`https://www.deribit.com/api/v2/public/ticker?instrument_name=${instrumentName}`, { timeout: TIMEOUT });
            const data = await response.json();
            if (data?.result) return data.result;
            console.error(`⚠️ Tentativa ${attempt + 1}/${MAX_RETRIES} - Nenhum resultado para ${instrumentName}`);
        } catch (e) {
            console.error(`🚫 Tentativa ${attempt + 1}/${MAX_RETRIES} - Erro ao buscar ticker para ${instrumentName}: ${e.message}`);
        }
        if (attempt < MAX_RETRIES - 1) await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
    }
    return null;
}

// Função principal
async function getDeribitGammaAndCCILevels() {
    try {
        console.log("🔄 Buscando dados da Deribit e Binance...");

        // 1. Preço spot do BTC
        const spotRes = await fetch("https://www.deribit.com/api/v2/public/get_index_price?index_name=btc_usd", { timeout: TIMEOUT });
        const spotData = await spotRes.json();
        if (!spotData?.result) throw new Error("Erro ao buscar preço spot na Deribit.");
        const spotPrice = spotData.result.index_price;

        // 2. Dados de todas as opções de BTC (Deribit)
        let options = [];
        for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
            try {
                const optionsRes = await fetch("https://www.deribit.com/api/v2/public/get_instruments?currency=BTC&kind=option&expired=false", { timeout: TIMEOUT });
                const instrumentsData = await optionsRes.json();
                if (!instrumentsData?.result || !Array.isArray(instrumentsData.result)) {
                    throw new Error("Nenhuma opção encontrada na Deribit.");
                }

                // Processar em lotes
                const instruments = instrumentsData.result.filter(instrument => {
                    const strike = instrument.strike;
                    return Math.abs(strike - spotPrice) <= STRIKE_RANGE_FUTURE * spotPrice;
                });
                console.log(`🔍 Encontrados ${instruments.length} instrumentos válidos`);

                const fetchTickers = async (batch) => {
                    const results = [];
                    for (const instrument of batch) {
                        const tickerData = await fetchTickerWithRetry(instrument.instrument_name);
                        if (tickerData) {
                            results.push({
                                instrument_name: instrument.instrument_name,
                                strike: instrument.strike,
                                open_interest: tickerData.open_interest || 0,
                                option_type: instrument.option_type.toLowerCase(),
                                expiry: instrument.expiration_timestamp,
                                mark_iv: tickerData.mark_iv / 100 || 0.5
                            });
                        }
                        await new Promise(resolve => setTimeout(resolve, REQUEST_DELAY));
                    }
                    return results;
                };

                // Dividir em lotes
                for (let i = 0; i < instruments.length; i += BATCH_SIZE) {
                    const batch = instruments.slice(i, i + BATCH_SIZE);
                    const batchResults = await fetchTickers(batch);
                    options.push(...batchResults);
                    console.log(`✅ Processado lote ${i / BATCH_SIZE + 1}/${Math.ceil(instruments.length / BATCH_SIZE)}`);
                }

                if (options.length > 0) break;
            } catch (e) {
                console.error(`🚫 Tentativa ${attempt + 1}/${MAX_RETRIES} - Erro ao buscar opções da Deribit: ${e.message}`);
                if (attempt < MAX_RETRIES - 1) await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
            }
        }

        if (options.length === 0) {
            console.warn("⚠️ Nenhuma opção encontrada na Deribit. Tentando Bybit...");
            options = await getBybitOptions(spotPrice);
        }

        // 3. Filtrar opções válidas
        options = options.filter(option => option.expiry && option.strike && option.option_type);
        console.log(`✅ ${options.length} opções válidas após filtro`);

        // 4. Separar por 0DTE e Futuras
        const now = new Date();
        const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const nowMidnight = getMidnightTimestamp(today);
        const tomorrow = new Date(today.getTime() + 24 * 60 * 60 * 1000);
        const cutoffTime = new Date(tomorrow.getFullYear(), tomorrow.getMonth(), tomorrow.getDate(), 8, 0, 0, 0).getTime();

        const zeroDteOptions = options.filter(option => {
            return option.expiry <= cutoffTime && option.expiry >= now.getTime() && Math.abs(option.strike - spotPrice) <= STRIKE_RANGE_0DTE * spotPrice;
        });

        const oneWeekFromNow = getMidnightTimestamp(new Date(Date.now() + 7 * 24 * 60 * 60 * 1000));
        const futureOptions = options.filter(option => option.expiry >= tomorrow.getTime() && option.expiry <= oneWeekFromNow);

        // 5. Agrupar strikes e calcular Gamma
        const processStrikes = (opts) => {
            const strikes = {};
            opts.forEach(option => {
                const strike = option.strike;
                const oi = option.open_interest || 0;
                const isCall = option.option_type === "call";
                const timeToExpiry = (option.expiry - now.getTime()) / (1000 * 60 * 60 * 24 * 365);
                const gamma = estimateGamma(spotPrice, strike, timeToExpiry, option.mark_iv);

                if (!strikes[strike]) {
                    strikes[strike] = { callOi: 0, putOi: 0, callGamma: 0, putGamma: 0 };
                }

                if (isCall) {
                    strikes[strike].callOi += oi;
                    strikes[strike].callGamma += gamma * oi;
                } else {
                    strikes[strike].putOi += oi;
                    strikes[strike].putGamma -= gamma * oi;
                }
            });
            return strikes;
        };

        const zeroDteStrikes = processStrikes(zeroDteOptions);
        const futureStrikes = processStrikes(futureOptions);
        console.log("Strikes 0DTE:", zeroDteStrikes);
        console.log("Strikes Futuras:", futureStrikes);

        // 6. Encontrar Call Wall, Put Wall e GammaFlip
        const calculateLevels = (strikes) => {
            let maxCallGamma = 0, callWallStrike = null;
            let maxPutGamma = 0, putWallStrike = null;
            let gammaFlip = null;

            const totalGammas = [];
            Object.entries(strikes).forEach(([strike, value]) => {
                const totalGamma = value.callGamma + value.putGamma;
                totalGammas.push({ strike: parseFloat(strike), totalGamma });

                if (value.callGamma > maxCallGamma) {
                    maxCallGamma = value.callGamma;
                    callWallStrike = parseFloat(strike);
                }
                if (value.putGamma < -maxPutGamma) {
                    maxPutGamma = -value.putGamma;
                    putWallStrike = parseFloat(strike);
                }
            });

            totalGammas.sort((a, b) => a.strike - b.strike);
            for (let i = 0; i < totalGammas.length - 1; i++) {
                if (totalGammas[i].totalGamma * totalGammas[i + 1].totalGamma < 0) {
                    gammaFlip = ((totalGammas[i].strike + totalGammas[i + 1].strike) / 2).toFixed(0);
                    break;
                }
            }

            return { callWallStrike, putWallStrike, gammaFlip: gammaFlip || spotPrice };
        };

        const zeroDteLevels = calculateLevels(zeroDteStrikes);
        const futureLevels = calculateLevels(futureStrikes);

        // 7. Coletar CCI dos timeframes
        const symbol = "BTCUSDT";
        const intervals = { "15m": "15m", "1h": "1h", "4h": "4h", "1d": "1d" };
        const cciLevels = {};
        for (const [name, interval] of Object.entries(intervals)) {
            const candles = await getCandles(symbol, interval, 25);
            const cci = calculateCCI(candles);
            cciLevels[name] = {
                value: cci,
                interpretation: interpretCCI(parseFloat(cci))
            };
        }

        // 8. Carregar último JSON como fallback
        const lastResult = loadLastJson();
        const result = {
            btc: {
                call_wall: futureLevels.callWallStrike || (lastResult?.btc.call_wall || spotPrice * 1.05),
                put_wall: futureLevels.putWallStrike || (lastResult?.btc.put_wall || spotPrice * 0.95),
                gamma_flip: futureLevels.gammaFlip || (lastResult?.btc.gamma_flip || spotPrice),
                call_wall_0dte: zeroDteLevels.callWallStrike || (lastResult?.btc.call_wall_0dte || spotPrice * 1.025),
                put_wall_0dte: zeroDteLevels.putWallStrike || (lastResult?.btc.put_wall_0dte || spotPrice * 0.975)
            }
        };
        saveJson(result);

        // 9. Montar mensagem final
        const timestamp = new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });
        const nextFutureExpiry = futureOptions.length > 0 ? new Date(Math.min(...futureOptions.map(o => o.expiry))) : null;
        const expiry0Dte = zeroDteOptions.length > 0 ? new Date(Math.min(...zeroDteOptions.map(o => o.expiry))) : null;

        const message = `
📊 *Gamma Levels BTCUSDT.P (${timestamp})*

💰 Spot Price: ${spotPrice.toLocaleString()}

🕒 Expiry (Futuras): ${nextFutureExpiry ? nextFutureExpiry.toLocaleDateString("pt-BR") : "N/A"}
🕒 Expiry (0DTE): ${expiry0Dte ? new Date(expiry0Dte).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" }) : "N/A"}

🟠 Call Wall (Futuras): ${result.btc.call_wall ? `${result.btc.call_wall.toLocaleString()}` : "`Sem dados no momento`"}
🟡 Put Wall (Futuras): ${result.btc.put_wall ? `${result.btc.put_wall.toLocaleString()}` : "`Sem dados no momento`"}
🟢 GammaFlip (Futuras): ${result.btc.gamma_flip ? `${result.btc.gamma_flip.toLocaleString()}` : "`Dados não disponíveis`"}

🟠 Call Wall (0DTE): ${result.btc.call_wall_0dte ? `${result.btc.call_wall_0dte.toLocaleString()}` : "`Nenhuma opção 0DTE ativa encontrada`"}
🟡 Put Wall (0DTE): ${result.btc.put_wall_0dte ? `${result.btc.put_wall_0dte.toLocaleString()}` : "`Nenhuma opção 0DTE ativa encontrada`"}
🟢 GammaFlip (0DTE): ${result.btc.gamma_flip ? `${result.btc.gamma_flip.toLocaleString()}` : "`Dados 0DTE não disponíveis`"}

📉 *Indicador CCI (20 períodos)*
15m: ${cciLevels["15m"].value} ➡️ ${cciLevels["15m"].interpretation}
1h:  ${cciLevels["1h"].value}  ➡️ ${cciLevels["1h"].interpretation}
4h:  ${cciLevels["4h"].value}  ➡️ ${cciLevels["4h"].interpretation}
1d:  ${cciLevels["1d"].value}  ➡️ ${cciLevels["1d"].interpretation}

✅ Futuras: ${futureOptions.length} opções encontradas
✅ 0DTE: ${zeroDteOptions.length} opções encontradas

ℹ️ Os níveis Gamma são baseados nos strikes com maior Open Interest ajustado por Gamma.
`;

        console.log("✅ Dados coletados com sucesso!");
        console.log(message);

        await sendTelegramMessage(message);

    } catch (e) {
        const errorMessage = `❌ Erro ao buscar dados: ${e.message}`;
        console.error(errorMessage);
        await sendTelegramMessage(errorMessage);
    }
}

// Roda agora
getDeribitGammaAndCCILevels();

// Agendamento: roda a cada 15 minutos
setInterval(getDeribitGammaAndCCILevels, 20 * 60 * 1000);
