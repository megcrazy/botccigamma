import fetch from "node-fetch";
import technicalindicators from "technicalindicators";

// === CONFIGURAÇÕES ===
const TELEGRAM_BOT_TOKEN = "7234385171:AAER1olpTjHrFqV8fO88gTXbmWAkX_4tMV4"; // Seu Bot Token
const TELEGRAM_CHAT_ID = "-1002545603959"; // Seu Chat ID

// Função para enviar mensagem no Telegram
async function sendTelegramMessage(message) {
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`; 
    try {
        const response = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                chat_id: TELEGRAM_CHAT_ID,
                text: message,
                parse_mode: "Markdown"
            })
        });
        const result = await response.json();
        if (!result.ok) {
            console.error("❌ Erro na API do Telegram:", result);
        } else {
            console.log("✅ Mensagem enviada para o Telegram!");
        }
    } catch (e) {
        console.error("🚫 Erro ao enviar para Telegram:", e.message);
    }
}

// Função para buscar velas da Binance
async function getCandles(symbol, interval, limit = 25) {
    try {
        const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
        const response = await fetch(url);
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
    if (!candles || candles.length === 0) {
        return "N/A";
    }
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


function getMidnightTimestamp(date) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

// Função para buscar opções da Bybit (fallback)
async function getBybitOptions() {
    try {
        const url = "https://api.bybit.com/v5/market/instruments-info?category=option&symbol=BTC";
        const response = await fetch(url);
        const data = await response.json();
        if (!data.result?.list) {
            console.warn("⚠️ Nenhuma opção encontrada na Bybit.");
            return [];
        }
        return data.result.list.map(item => ({
            instrument_name: item.symbol,
            strike: parseFloat(item.strikePrice),
            open_interest: parseFloat(item.openInterest) || 0,
            option_type: item.optionType.toLowerCase(),
            expiry: new Date(item.expiryDate).getTime()
        }));
    } catch (e) {
        console.error("🚫 Erro ao buscar opções da Bybit:", e.message);
        return [];
    }
}

// Função principal
async function getDeribitGammaAndCCILevels() {
    try {
        console.log("🔄 Buscando dados da Deribit e Binance...");

        // 1. Preço spot do BTC
        const spotRes = await fetch("https://www.deribit.com/api/v2/public/get_index_price?index_name=btc_usd");
        const spotData = await spotRes.json();

        if (!spotData?.result) {
            throw new Error("Erro ao buscar preço spot na Deribit.");
        }

        const spotPrice = spotData.result.index_price;

        // 2. Dados de todas as opções de BTC (Deribit)
        const optionsRes = await fetch("https://www.deribit.com/api/v2/public/get_instruments?currency=BTC&kind=option&expired=false");
        const instrumentsData = await optionsRes.json();

        let options = [];
        if (instrumentsData?.result && Array.isArray(instrumentsData.result)) {
            const fetchTickers = instrumentsData.result.map(async instrument => {
                try {
                    const tickerRes = await fetch(`https://www.deribit.com/api/v2/public/ticker?instrument_name=${instrument.instrument_name}`);
                    const tickerData = await tickerRes.json();
                    if (tickerData?.result) {
                        return {
                            instrument_name: instrument.instrument_name,
                            strike: instrument.strike,
                            open_interest: tickerData.result.open_interest || 0,
                            option_type: instrument.option_type.toLowerCase(),
                            expiry: instrument.expiration_timestamp,
                            mark_iv: tickerData.result.mark_iv || 0.5 // Default IV if not available
                        };
                    }
                } catch (e) {
                    console.error(`🚫 Erro ao buscar ticker para ${instrument.instrument_name}: ${e.message}`);
                }
                return null;
            });
            options = (await Promise.all(fetchTickers)).filter(Boolean);
        } else {
            console.warn("⚠️ Nenhuma opção encontrada na Deribit. Tentando Bybit...");
            options = await getBybitOptions();
        }

        // 3. Extrair e padronizar expiry
        options = options.filter(option => option.expiry !== null && option.strike !== null && option.option_type !== null);

        // 4. Separar por 0DTE e Futuras
        const now = new Date();
        const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const nowMidnight = getMidnightTimestamp(today);
        const tomorrow = new Date(today.getTime() + 24 * 60 * 60 * 1000);
        const cutoffTime = new Date(tomorrow.getFullYear(), tomorrow.getMonth(), tomorrow.getDate(), 8, 0, 0, 0).getTime(); // 08:00 UTC do dia seguinte

        const zeroDteOptions = options.filter(option => {
            if (!option.expiry) return false;
            // Opções 0DTE são aquelas que expiram antes ou no cutoffTime e depois ou no tempo atual
            return option.expiry <= cutoffTime && option.expiry >= now.getTime();
        });

        const oneWeekFromNow = getMidnightTimestamp(new Date(Date.now() + 7 * 24 * 60 * 60 * 1000));
        const futureOptions = options.filter(option => option.expiry >= tomorrow.getTime() && option.expiry <= oneWeekFromNow);

        // 5. Agrupar strikes por Call e Put (0DTE)
        const zeroDteStrikes = {};
        zeroDteOptions.forEach(option => {
            const strike = option.strike;
            const oi = option.open_interest || 0;
            const isCall = option.option_type === "call";

            if (!zeroDteStrikes[strike]) {
                zeroDteStrikes[strike] = { callOi: 0, putOi: 0 };
            }

            if (isCall) {
                zeroDteStrikes[strike].callOi += oi;
            } else {
                zeroDteStrikes[strike].putOi += oi;
            }
        });
        console.log("Strikes 0DTE:", zeroDteStrikes);

        // 6. Encontrar Call Wall e Put Wall (0DTE)
        let maxCallOiZeroDTE = 0;
        let callWallStrikeZeroDTE = null;
        let maxPutOiZeroDTE = 0;
        let putWallStrikeZeroDTE = null;

        Object.entries(zeroDteStrikes).forEach(([strike, value]) => {
            if (value.callOi > maxCallOiZeroDTE) {
                maxCallOiZeroDTE = value.callOi;
                callWallStrikeZeroDTE = parseFloat(strike);
            }
            if (value.putOi > maxPutOiZeroDTE) {
                maxPutOiZeroDTE = value.putOi;
                putWallStrikeZeroDTE = parseFloat(strike);
            }
        });

        // 7. Calcular Gamma Flip (0DTE)
        const gammaFlipZeroDTE = callWallStrikeZeroDTE && putWallStrikeZeroDTE ? ((callWallStrikeZeroDTE + putWallStrikeZeroDTE) / 2).toFixed(0) : null;

        // 8. Agrupar strikes por Call e Put (Futuras)
        const futureStrikes = {};
        futureOptions.forEach(option => {
            const strike = option.strike;
            const oi = option.open_interest || 0;
            const isCall = option.option_type === "call";

            if (!futureStrikes[strike]) {
                futureStrikes[strike] = { callOi: 0, putOi: 0 };
            }

            if (isCall) {
                futureStrikes[strike].callOi += oi;
            } else {
                futureStrikes[strike].putOi += oi;
            }
        });
        console.log("Strikes Futuras:", futureStrikes);

        // 9. Call/Put Wall Futuras
        let maxCallOiFuture = 0;
        let callWallStrikeFuture = null;
        let maxPutOiFuture = 0;
        let putWallStrikeFuture = null;

        Object.entries(futureStrikes).forEach(([strike, value]) => {
            if (value.callOi > maxCallOiFuture) {
                maxCallOiFuture = value.callOi;
                callWallStrikeFuture = parseFloat(strike);
            }
            if (value.putOi > maxPutOiFuture) {
                maxPutOiFuture = value.putOi;
                putWallStrikeFuture = parseFloat(strike);
            }
        });

        // 10. Gamma Flip Futuras
        const gammaFlipFuture = callWallStrikeFuture && putWallStrikeFuture ? ((callWallStrikeFuture + putWallStrikeFuture) / 2).toFixed(0) : null;

        // 11. Coletar CCI dos timeframes
        const symbol = "BTCUSDT";
        const intervals = {
            "15m": "15m",
            "1h": "1h",
            "4h": "4h",
            "1d": "1d"
        };

        const cciLevels = {};
        for (const [name, interval] of Object.entries(intervals)) {
            const candles = await getCandles(symbol, interval, 25);
            const cci = calculateCCI(candles);
            cciLevels[name] = {
                value: cci,
                interpretation: interpretCCI(parseFloat(cci))
            };
        }

        // 12. Montar mensagem final com fallback
        const nextFutureExpiry = futureOptions.length > 0 ? new Date(Math.min(...futureOptions.map(o => o.expiry))) : null;

        const message = `
📊 *Gamma Levels BTCUSDT.P* (${new Date().toLocaleString('pt-BR')})

💰 Spot Price: ${spotPrice.toLocaleString()}

🕒 Expiry (Futuras): ${nextFutureExpiry ? nextFutureExpiry.toLocaleDateString("pt-BR") : "N/A"}
🕒 Expiry (0DTE): ${new Date(nowMidnight).toLocaleDateString("pt-BR")}

🟠 Call Wall (Futuras): ${callWallStrikeFuture ? `${callWallStrikeFuture.toLocaleString()}` : "`Sem dados no momento`"}
🟡 Put Wall (Futuras): ${putWallStrikeFuture ? `${putWallStrikeFuture.toLocaleString()}` : "`Sem dados no momento`"}
🟢 GammaFlip (Futuras): ${gammaFlipFuture ? `${gammaFlipFuture.toLocaleString()}` : "`Dados não disponíveis`"}

🟠 Call Wall (0DTE): ${callWallStrikeZeroDTE ? `${callWallStrikeZeroDTE.toLocaleString()}` : "`Nenhuma opção 0DTE ativa encontrada`"}
🟡 Put Wall (0DTE): ${putWallStrikeZeroDTE ? `${putWallStrikeZeroDTE.toLocaleString()}` : "`Nenhuma opção 0DTE ativa encontrada`"}
🟢 GammaFlip (0DTE): ${gammaFlipZeroDTE ? `${gammaFlipZeroDTE.toLocaleString()}` : "`Dados 0DTE não disponíveis`"}

📉 *Indicador CCI (20 períodos)*
15m: ${cciLevels["15m"].value} ➡️ ${cciLevels["15m"].interpretation}
1h:  ${cciLevels["1h"].value}  ➡️ ${cciLevels["1h"].interpretation}
4h:  ${cciLevels["4h"].value}  ➡️ ${cciLevels["4h"].interpretation}
1d:  ${cciLevels["1d"].value}  ➡️ ${cciLevels["1d"].interpretation}

✅ Futuras: ${futureOptions.length} opções encontradas
✅ 0DTE: ${zeroDteOptions.length} opções encontradas

ℹ️ Os níveis Gamma são baseados nos strikes com maior Open Interest.
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

// Agendamento: roda a cada 1 hora
setInterval(getDeribitGammaAndCCILevels, 15 * 60 * 1000);

