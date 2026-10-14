// =====================================================
// VicoPay Forex Academy — lesson content
// Lessons are sent ONLY to paid members (lesson 1 is a free preview), so the paywall cannot be skipped by
// viewing the page source. Everything here is general education, never personal financial advice.
// Block types:  p = paragraph,  ul = bullet list,  tip = highlighted tip,  warn = highlighted warning
// =====================================================
const LESSONS = [
  {
    id: 1, module: "Module 1 · Foundations", title: "What is forex, really?", minutes: 6,
    blocks: [
      { t: "p", x: "Forex (foreign exchange) is the market where one currency is exchanged for another. When you travel and swap naira for dollars, you have made a forex trade. Banks, companies, governments and individual traders do the same thing all day, every weekday, which makes it the largest financial market in the world." },
      { t: "p", x: "Currencies are always traded in pairs, such as EUR/USD. The first currency (EUR) is the base, the second (USD) is the quote. A price of 1.0800 means 1 euro costs 1.08 US dollars. If the price rises to 1.0900, the euro got stronger against the dollar; if it falls, the euro got weaker." },
      { t: "ul", x: ["Major pairs always include the US dollar: EUR/USD, GBP/USD, USD/JPY, USD/CHF, USD/CAD, AUD/USD, NZD/USD.", "Majors usually have the tightest spreads (lowest trading cost) and the most liquidity.", "The market is open 24 hours a day from Monday to Friday, moving between Sydney, Tokyo, London and New York sessions."] },
      { t: "tip", x: "Buying EUR/USD means you expect the euro to rise against the dollar. Selling it means you expect the opposite. You are always comparing two currencies, never just one." }
    ],
    takeaway: "Forex is currency swapping in pairs. Price tells you how much of the quote currency one unit of the base currency costs.",
    quiz: [
      { q: "In the pair GBP/USD, which currency is the BASE currency?", o: ["USD", "GBP", "Both", "Neither"], a: 1, why: "The first currency in a pair is the base. The price shows how much of the quote currency (USD) one GBP costs." },
      { q: "EUR/USD moves from 1.0800 to 1.0900. What happened?", o: ["The euro got stronger against the dollar", "The dollar got stronger against the euro", "Nothing, it is only a number", "Both currencies fell"], a: 0, why: "One euro now buys more dollars, so the euro strengthened relative to the dollar." }
    ]
  },
  {
    id: 2, module: "Module 1 · Foundations", title: "Pips, lots and spreads", minutes: 8,
    blocks: [
      { t: "p", x: "A pip is the standard small unit of price movement. For most pairs it is the 4th decimal place (0.0001). For pairs with the Japanese yen it is the 2nd decimal place (0.01). If EUR/USD moves from 1.0800 to 1.0825, it moved 25 pips." },
      { t: "p", x: "A lot is the size of your trade. One standard lot is 100,000 units of the base currency. A mini lot (0.10) is 10,000 units and a micro lot (0.01) is 1,000 units. The bigger the lot, the more each pip is worth." },
      { t: "ul", x: ["On EUR/USD, 1 pip is about $10 per standard lot (1.00).", "It is about $1 per mini lot (0.10).", "It is about $0.10 per micro lot (0.01)."] },
      { t: "p", x: "The spread is the difference between the price you can buy at (ask) and sell at (bid). It is a cost you pay every time you open a trade. If the spread is 1.2 pips, your trade starts 1.2 pips in the red and must move in your favour just to break even." },
      { t: "warn", x: "Small lots are not boring, they are smart. Beginners who start with big lots can lose in minutes what they spent weeks saving." }
    ],
    takeaway: "Pips measure movement, lots set how much each pip is worth, and the spread is the toll you pay to enter.",
    quiz: [
      { q: "EUR/USD moves from 1.0800 to 1.0825. How many pips is that?", o: ["2.5", "25", "250", "0.25"], a: 1, why: "The 4th decimal place is one pip. 0.0025 is 25 pips." },
      { q: "About how much is one pip worth on EUR/USD with a 0.10 (mini) lot?", o: ["$0.10", "$1", "$10", "$100"], a: 1, why: "A standard lot is about $10 per pip, so a mini lot (one tenth) is about $1 per pip." }
    ]
  },
  {
    id: 3, module: "Module 2 · Reading the market", title: "Reading candlesticks", minutes: 8,
    blocks: [
      { t: "p", x: "A candlestick shows four prices for a period of time: the open, high, low and close. The thick part is the body (open to close). The thin lines are wicks (shadows) that show how far price travelled before pulling back." },
      { t: "ul", x: ["Bullish candle: the close is higher than the open (often green or white).", "Bearish candle: the close is lower than the open (often red or black).", "Long upper wick: buyers pushed up, but sellers pushed price back down.", "Long lower wick: sellers pushed down, but buyers pushed price back up.", "Doji: open and close are almost equal, showing indecision."] },
      { t: "p", x: "A pin bar has a small body and one long wick. At an important level, it can show that price was rejected. A single candle is never a guarantee, it is a clue. Always read candles together with the trend and key levels." },
      { t: "tip", x: "Change the timeframe to see the bigger story. A tiny 1-minute move can be just noise inside a strong 4-hour trend." }
    ],
    takeaway: "Candles show the fight between buyers and sellers. Bodies show who won the period, wicks show who was rejected.",
    quiz: [
      { q: "A candle closes ABOVE where it opened. What is it called?", o: ["Bullish", "Bearish", "Doji", "Spread"], a: 0, why: "Close above open means buyers won that period: a bullish candle." },
      { q: "A candle has a very long upper wick and a small body. What does it often suggest?", o: ["Guaranteed profit", "Price was pushed up but rejected", "The market is closed", "The spread is zero"], a: 1, why: "The long upper wick shows buyers drove price higher but sellers pushed it back down. It is a clue, not a guarantee." }
    ]
  },
  {
    id: 4, module: "Module 2 · Reading the market", title: "Support, resistance and trends", minutes: 9,
    blocks: [
      { t: "p", x: "Support is a price area where falling prices have often stopped and bounced. Resistance is an area where rising prices have often stopped and turned down. They are zones, not exact lines." },
      { t: "p", x: "An uptrend makes higher highs and higher lows. A downtrend makes lower highs and lower lows. When there is no clear direction, the market is ranging, moving sideways between support and resistance." },
      { t: "ul", x: ["Trade WITH the trend more often than against it.", "A broken resistance level can become new support (and the opposite).", "A breakout can fail. Waiting for a retest or confirmation can reduce false signals, though never to zero.", "More touches of a level usually make it more important."] },
      { t: "tip", x: "Mark levels on a higher timeframe (like the daily chart) first, then zoom in. Levels from bigger timeframes usually matter more." }
    ],
    takeaway: "Know where price has reacted before, and know the trend direction. Then decide if a trade even makes sense.",
    quiz: [
      { q: "Which pattern describes an UPTREND?", o: ["Lower highs and lower lows", "Higher highs and higher lows", "Price staying exactly flat", "Only red candles"], a: 1, why: "An uptrend keeps making higher highs and higher lows." },
      { q: "Price breaks above resistance. What can that old resistance level become?", o: ["Support", "A guaranteed winner", "Irrelevant", "A new spread"], a: 0, why: "Broken resistance often turns into support, though it is not guaranteed." }
    ]
  },
  {
    id: 5, module: "Module 3 · Protecting your capital", title: "Risk management that keeps you in the game", minutes: 10,
    blocks: [
      { t: "p", x: "Most beginners focus on how much they could win. Professionals focus first on how much they could lose. The most common rule is to risk only a small percentage (many traders use 1% or less) of the account on any single trade." },
      { t: "p", x: "A stop-loss is an order that closes your trade at a price you choose if the market goes against you. You decide the exit BEFORE you enter, when you are calm, not after the trade has already hurt." },
      { t: "p", x: "Position size formula:  lots = (account × risk %) ÷ (stop-loss in pips × pip value per lot)." },
      { t: "ul", x: ["Example: a $1,000 account, risking 1% = $10.", "Your stop-loss is 20 pips away. On EUR/USD a pip is about $10 per standard lot.", "Lots = $10 ÷ (20 × $10) = 0.05 lots.", "If the stop-loss is hit, you lose about $10, which is 1% of the account."] },
      { t: "p", x: "Risk-reward ratio compares what you risk with what you aim to gain. Risking 20 pips to aim for 40 pips is 1:2. Good risk-reward can help, but it only works if you also stay disciplined and the setup is sound." },
      { t: "warn", x: "Stop-losses can slip in fast markets or around big news, so the loss can be larger than planned. This is one more reason to keep position sizes small." }
    ],
    takeaway: "Decide your risk, your stop-loss and your position size before you click. Survival comes first, profit comes second.",
    quiz: [
      { q: "You have a $2,000 account and risk 1% per trade. How much is that?", o: ["$2", "$20", "$200", "$1,000"], a: 1, why: "1% of $2,000 = $20." },
      { q: "When should you decide your stop-loss?", o: ["After the trade is losing", "Before you enter the trade", "Never", "Only when you feel scared"], a: 1, why: "Plan the exit before entering, while you are calm and objective." }
    ]
  },
  {
    id: 6, module: "Module 3 · Protecting your capital", title: "Leverage and margin", minutes: 8,
    blocks: [
      { t: "p", x: "Leverage lets you control a large position with a small amount of your own money. With 1:30 leverage, $1 of your money can control $30 of currency. The money set aside to hold the trade open is called margin." },
      { t: "p", x: "Example: you buy 1 standard lot of EUR/USD at 1.1000. The position is worth about $110,000. With 1:30 leverage the margin required is about $3,667." },
      { t: "ul", x: ["Leverage magnifies profits AND losses. Both.", "If your losses eat too much of your margin, the broker can close your trades automatically (a stop-out or margin call).", "Higher leverage is not a bonus, it is a bigger risk. Many beginners do better with low effective leverage."] },
      { t: "warn", x: "Anyone telling you high leverage is a shortcut to wealth is selling you a dream. Leveraged trading can wipe out your whole deposit." }
    ],
    takeaway: "Leverage is a tool, not a free gift. Use small sizes so one bad trade cannot end your account.",
    quiz: [
      { q: "What does leverage do to losses?", o: ["Removes them", "Magnifies them, just like profits", "Reduces them", "Nothing"], a: 1, why: "Leverage magnifies both gains and losses." },
      { q: "What is margin?", o: ["A trading fee", "Money set aside to keep a leveraged trade open", "Your profit", "The spread"], a: 1, why: "Margin is the deposit held while your leveraged position is open." }
    ]
  },
  {
    id: 7, module: "Module 4 · Mindset and plan", title: "Trading psychology", minutes: 7,
    blocks: [
      { t: "p", x: "Your biggest opponent is rarely the market. It is fear, greed and impatience. The charts can be right and you can still lose because you moved your stop, doubled your size, or jumped in without a plan." },
      { t: "ul", x: ["FOMO (fear of missing out): chasing a move that already happened.", "Revenge trading: trying to win back a loss immediately, usually with bigger size.", "Overtrading: taking trades out of boredom instead of because the plan says so.", "Moving a stop-loss further away because you 'hope' it will come back."] },
      { t: "p", x: "Habits that help: keep a trading journal, take breaks after a loss, set a daily loss limit, and never trade when you are angry, tired or desperate for money." },
      { t: "tip", x: "A missed trade costs nothing. A forced trade can cost a lot. There will always be another setup." }
    ],
    takeaway: "Control your behaviour and the results take care of themselves. Write down why you took each trade.",
    quiz: [
      { q: "You just lost a trade and want to win it back immediately with a bigger lot. What is this called?", o: ["Smart hedging", "Revenge trading", "Risk management", "Scalping"], a: 1, why: "Trying to recover a loss right away with more risk is revenge trading and usually makes things worse." },
      { q: "What is a good habit after a big loss?", o: ["Double the next trade", "Take a break and review the trade in your journal", "Remove all stop-losses", "Ask a stranger for a signal"], a: 1, why: "A calm review beats an emotional reaction." }
    ]
  },
  {
    id: 8, module: "Module 4 · Mindset and plan", title: "Build your trading plan (and avoid scams)", minutes: 9,
    blocks: [
      { t: "p", x: "A trading plan is a short written set of rules you follow every time. Here is a simple starter checklist you can copy into your journal:" },
      { t: "ul", x: ["Which pairs will I trade, and in which session?", "What setup must I see before I enter? (trend, level, candle signal)", "How much will I risk per trade? (for example 1% or less)", "Where is my stop-loss and where is my target?", "When will I stop trading for the day?", "How will I review my trades every week?"] },
      { t: "p", x: "Practise this plan on the Practice Trading tab first. Treat practice money as real money so you build the right habits. Only consider live trading after you have followed your plan consistently over many trades, and only with money you can afford to lose." },
      { t: "warn", x: "Scam warning signs: guaranteed profits, 'doubling your money in days', paid signal groups that show only wins, people asking you to send money to a 'manager' to trade for you, and pressure to deposit quickly. Check that any broker is regulated where you live." },
      { t: "tip", x: "Education is the safest investment you can make in trading. Skills stay with you even when markets change." }
    ],
    takeaway: "Write the plan, practise it, review it. Be suspicious of anyone who promises easy money.",
    quiz: [
      { q: "Which of these is a classic scam warning sign?", o: ["A broker regulated in your country", "A promise of guaranteed profits", "A demo account", "A written trading plan"], a: 1, why: "No one can guarantee profits in trading. Guaranteed returns are a major red flag." },
      { q: "Where should you first practise a new plan?", o: ["With borrowed money", "On a demo or practice account", "During big news with a huge lot", "Nowhere, just start live"], a: 1, why: "Practise on a demo account so mistakes cost nothing." }
    ]
  }
];

const GLOSSARY = [
  ["Ask", "The price at which you can BUY a currency pair."],
  ["Bid", "The price at which you can SELL a currency pair."],
  ["Base currency", "The first currency in a pair (EUR in EUR/USD)."],
  ["Quote currency", "The second currency in a pair (USD in EUR/USD). Prices are shown in this currency."],
  ["Pip", "The standard unit of price movement: 0.0001 for most pairs, 0.01 for yen pairs."],
  ["Lot", "Trade size. 1.00 = 100,000 units, 0.10 = 10,000 units, 0.01 = 1,000 units."],
  ["Spread", "The difference between bid and ask. It is the cost of entering a trade."],
  ["Leverage", "Using borrowed buying power to control a bigger position than your deposit. Magnifies profits and losses."],
  ["Margin", "The deposit your broker holds while a leveraged trade is open."],
  ["Margin call", "A warning (or automatic closing of trades) when your account equity is too low to support open trades."],
  ["Stop-loss", "An order that closes your trade at a set price to limit your loss."],
  ["Take-profit", "An order that closes your trade at a set price to lock in profit."],
  ["Equity", "Your account balance plus or minus the profit/loss of open trades."],
  ["Drawdown", "How far your account has fallen from its highest point."],
  ["Slippage", "When your order fills at a different price than expected, common in fast markets."],
  ["Liquidity", "How easily you can buy or sell without moving the price. Major pairs are very liquid."],
  ["Volatility", "How much and how quickly price moves."],
  ["Risk-reward ratio", "The potential gain compared with the amount risked. Risking 20 pips for 40 pips = 1:2."],
  ["Support", "A price area where falling prices have often stopped and bounced."],
  ["Resistance", "A price area where rising prices have often stopped and turned down."],
  ["Trend", "The general direction of price: up, down, or sideways (ranging)."],
  ["Breakout", "When price moves beyond a support or resistance level."],
  ["Candlestick", "A chart bar showing the open, high, low and close for a period."],
  ["Demo account", "A practice account with virtual money and no real risk."],
  ["Journal", "A written record of each trade and why you took it, used to learn from mistakes."]
];


// =====================================================
// AI VIDEO LESSONS: an animated, AI-narrated lesson that plays after each quiz.
// Each scene has a heading (h), what the AI tutor says (say), and a visual (v + d) drawn by forex.html.
// To use a REAL recorded video for a lesson instead, put its address in `url` (an .mp4 file, or a YouTube / Vimeo embed link).
// =====================================================
const VIDEOS = {
  1: { url: "", scenes: [
    { h: "What is forex?", v: "title", d: { sub: "Lesson 1 · Foundations" }, say: "Welcome to the Vicopay Forex Academy. I am your A I tutor. In this lesson you will learn what forex is, and how currency pairs work." },
    { h: "Currencies trade in pairs", v: "pair", d: { base: "EUR", quote: "USD", price: "1.0800" }, say: "Forex means exchanging one currency for another. Currencies always trade in pairs, like euro dollar. The first currency is the base. The second is the quote. A price of one point zero eight hundred means one euro costs one point zero eight dollars." },
    { h: "When the price rises", v: "move", d: { from: 1.08, to: 1.09, label: "EUR/USD rises: the euro gets stronger" }, say: "If the price rises, the euro is getting stronger against the dollar. If it falls, the euro is getting weaker. You are always comparing two currencies, never just one." },
    { h: "A market that follows the sun", v: "sessions", d: {}, say: "The forex market is open twenty four hours a day, from Monday to Friday. It moves between Sydney, Tokyo, London and New York. The busiest hours are when London and New York are both open." },
    { h: "Remember", v: "bullets", d: { items: ["Forex = swapping currencies in pairs", "Base currency first, quote currency second", "Price = how much quote for one base", "Majors always include the US dollar"] }, say: "To remember. Forex is swapping currencies in pairs. The base comes first, the quote comes second. The price tells you how much of the quote currency one base currency costs. Now go and practise what you learned." }
  ] },
  2: { url: "", scenes: [
    { h: "Pips, lots and spreads", v: "title", d: { sub: "Lesson 2 · Foundations" }, say: "Let us learn how forex trades are measured. Pips, lots, and spreads." },
    { h: "What is a pip?", v: "pips", d: { from: 1.0800, to: 1.0825 }, say: "A pip is the smallest standard price move. For most pairs it is the fourth decimal place. If euro dollar moves from one point zero eight hundred to one point zero eight twenty five, that is twenty five pips." },
    { h: "What is a lot?", v: "bars", d: { a: { label: "Micro 0.01", value: 1 }, b: { label: "Mini 0.10", value: 10 }, c: { label: "Standard 1.00", value: 100 }, unit: "$ per pip x 0.1" }, say: "A lot is the size of your trade. A standard lot is one hundred thousand units, and one pip is worth about ten dollars. A mini lot is ten times smaller, and a micro lot is a hundred times smaller. Beginners should start small." },
    { h: "The spread is a cost", v: "bullets", d: { items: ["Bid = where you can SELL", "Ask = where you can BUY", "Spread = the gap between them", "You start every trade slightly negative"] }, say: "The spread is the difference between the price you can sell at, called the bid, and the price you can buy at, called the ask. It is a cost you pay each time you open a trade, so your trade starts a little in the red." },
    { h: "Remember", v: "bullets", d: { items: ["1 pip = 0.0001 on most pairs", "Bigger lot = bigger pip value", "Start with micro or mini lots"] }, say: "Remember. A pip is point zero zero zero one on most pairs. A bigger lot means every pip is worth more, for profit and for loss. Start small." }
  ] },
  3: { url: "", scenes: [
    { h: "Reading candlesticks", v: "title", d: { sub: "Lesson 3 · Reading the market" }, say: "Candlesticks are the language of the chart. Let us learn to read them." },
    { h: "Anatomy of a candle", v: "candles", d: {}, say: "Each candle shows four prices: the open, the high, the low and the close. The thick part is the body. The thin lines are the wicks. A green candle closed higher than it opened. A red candle closed lower." },
    { h: "Wicks tell a story", v: "bullets", d: { items: ["Long upper wick: buyers were pushed back", "Long lower wick: sellers were pushed back", "Doji: open and close almost equal", "Pin bar: small body, long wick"] }, say: "Wicks show rejection. A long upper wick means buyers pushed price up, but sellers pushed it back down. A long lower wick means the opposite. A doji shows indecision." },
    { h: "Remember", v: "bullets", d: { items: ["One candle is a clue, never a guarantee", "Read candles with trend and levels", "Zoom out to see the bigger story"] }, say: "One candle is a clue, never a guarantee. Always read candles together with the trend and key levels, and zoom out to see the bigger story." }
  ] },
  4: { url: "", scenes: [
    { h: "Support, resistance and trends", v: "title", d: { sub: "Lesson 4 · Reading the market" }, say: "Now let us find where price likes to turn, and which way it is heading." },
    { h: "Support and resistance", v: "levels", d: { mode: "range" }, say: "Support is a zone where falling price has often bounced. Resistance is a zone where rising price has often turned down. They are zones, not exact lines. The more times price reacts there, the more important the level." },
    { h: "Trends", v: "levels", d: { mode: "trend" }, say: "In an uptrend, price makes higher highs and higher lows. In a downtrend, lower highs and lower lows. Trading with the trend is usually easier than fighting it." },
    { h: "Remember", v: "bullets", d: { items: ["Mark levels on a higher timeframe first", "Trade with the trend more often", "Broken resistance can become support", "Breakouts can fail: wait for confirmation"] }, say: "Mark your levels on a higher timeframe first. Trade with the trend more often than against it. A broken resistance can become support, and breakouts can fail, so be patient." }
  ] },
  5: { url: "", scenes: [
    { h: "Risk management", v: "title", d: { sub: "Lesson 5 · Protecting your capital" }, say: "This is the most important lesson in the academy. How to protect your money." },
    { h: "Risk a small percentage", v: "bars", d: { a: { label: "Account $1,000", value: 100 }, b: { label: "1% risk = $10", value: 1 }, unit: "" }, say: "Most professionals risk only one percent or less of their account on a single trade. On a thousand dollar account, that is ten dollars. Even ten losses in a row would not end your account." },
    { h: "Plan your exit first", v: "levels", d: { mode: "stop" }, say: "A stop loss closes your trade at a price you choose if the market goes against you. Decide it before you enter, while you are calm. Then size your trade so that hitting the stop loses only your planned amount." },
    { h: "The formula", v: "bullets", d: { items: ["Lots = (balance x risk %) / (stop pips x pip value)", "$1,000 x 1% = $10 risk", "20 pip stop on EUR/USD", "$10 / (20 x $10) = 0.05 lots"] }, say: "Lots equals account times risk percent, divided by stop loss pips times pip value. With a thousand dollars, one percent risk, and a twenty pip stop, you trade zero point zero five lots." },
    { h: "Remember", v: "bullets", d: { items: ["Decide risk BEFORE you click", "Always use a stop loss", "Survival first, profit second"] }, say: "Decide your risk before you click. Always use a stop loss. Survival comes first, profit comes second." }
  ] },
  6: { url: "", scenes: [
    { h: "Leverage and margin", v: "title", d: { sub: "Lesson 6 · Protecting your capital" }, say: "Leverage can look exciting, but it must be understood before it is used." },
    { h: "Leverage magnifies", v: "bars", d: { a: { label: "Your money $100", value: 10 }, b: { label: "Position at 1:30 = $3,000", value: 100 }, unit: "" }, say: "With one to thirty leverage, one hundred dollars of your money can control a three thousand dollar position. That magnifies profits, and it magnifies losses just the same." },
    { h: "Margin", v: "bullets", d: { items: ["Margin = deposit that holds the trade open", "1 lot EUR/USD at 1.1000 = about $110,000", "At 1:30 margin is about $3,667", "Too many losses = margin call or stop-out"] }, say: "Margin is the deposit held while your trade is open. One standard lot of euro dollar is worth about one hundred and ten thousand dollars, so at one to thirty you need about three thousand six hundred and sixty seven dollars as margin. If losses eat too much of it, trades are closed automatically." },
    { h: "Remember", v: "bullets", d: { items: ["Leverage is a tool, not a gift", "Use small sizes", "One bad trade must never end your account"] }, say: "Leverage is a tool, not a gift. Use small sizes, so that one bad trade can never end your account." }
  ] },
  7: { url: "", scenes: [
    { h: "Trading psychology", v: "title", d: { sub: "Lesson 7 · Mindset and plan" }, say: "The market is not your biggest opponent. Your emotions are." },
    { h: "Four traps", v: "bullets", d: { items: ["FOMO: chasing a move that already happened", "Revenge trading: bigger size after a loss", "Overtrading: trading out of boredom", "Moving your stop because you hope"] }, say: "Watch out for four traps. Fear of missing out, which makes you chase moves. Revenge trading, where you try to win back a loss with bigger size. Overtrading, trading just because you are bored. And moving your stop loss because you hope price will come back." },
    { h: "Habits that protect you", v: "bullets", d: { items: ["Keep a trading journal", "Set a daily loss limit", "Take a break after a loss", "Never trade angry, tired or desperate"] }, say: "Good habits protect you. Keep a journal. Set a daily loss limit. Take a break after a loss. And never trade when you are angry, tired, or desperate for money." },
    { h: "Remember", v: "bullets", d: { items: ["A missed trade costs nothing", "A forced trade can cost a lot", "There is always another setup"] }, say: "A missed trade costs nothing. A forced trade can cost a lot. There will always be another setup." }
  ] },
  8: { url: "", scenes: [
    { h: "Your trading plan", v: "title", d: { sub: "Lesson 8 · Mindset and plan" }, say: "Congratulations, you are at the final lesson. Let us build your trading plan." },
    { h: "A simple plan", v: "bullets", d: { items: ["Which pairs and which session?", "What setup must I see first?", "How much do I risk? (1% or less)", "Where are my stop and target?", "When do I stop for the day?", "How will I review my trades?"] }, say: "A trading plan is a short set of rules you follow every time. Which pairs and session will you trade? What setup must you see? How much will you risk? Where are your stop loss and target? When will you stop for the day? And how will you review your trades?" },
    { h: "Beware of scams", v: "bullets", d: { items: ["Guaranteed profits = red flag", "Paid signal groups showing only wins", "Anyone asking you to send money to trade for you", "Pressure to deposit quickly"] }, say: "Be careful. Guaranteed profits are a red flag. So are signal groups that show only wins, people asking you to send them money to trade for you, and any pressure to deposit quickly." },
    { h: "Practise first", v: "bullets", d: { items: ["Use Practice Trading to follow your plan", "Review every trade in your journal", "Only consider live trading when consistent", "Only with money you can afford to lose"] }, say: "Practise your plan in the Practice Trading tab and review every trade in your journal. Only think about live trading after you have been consistent over many trades, and only with money you can afford to lose. Well done, and good luck." }
  ] }
};

module.exports = { LESSONS, GLOSSARY, VIDEOS };
