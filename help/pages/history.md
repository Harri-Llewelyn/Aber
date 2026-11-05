## What this page is for

History charts a machine's readings over a period you choose. Open it to see how a device has behaved: whether a temperature crept up overnight, when a spindle stopped, or what a reading was last Tuesday.

The page has two tabs:

- **Device** draws one chart for each metric of one device, stacked down the page on the same time axis. Point at a chart to read the value at that moment; every chart shows the same moment. Otherwise each chart's title line shows its latest reading.
- **Alerts** lists every alert that fired over the window, with who acknowledged it and why. See [Alerts](#alerts).

Everyone who can sign in can open History. Each chart shows only what your account may read.

## Choosing a device and a window

1. Open **History** in the sidebar, directly below the Site Map. It lists every device.
2. Type in the search box to find a device by its name, its id, its cell or its area. Select its name.
3. Choose the period in the **time window**, after the device's name. It opens on **Last 24 hours**.
4. To chart another device, select its name in the toolbar and pick one from the list.

You can also start from a device. On the Devices page, open the device and select **View History**.

The time window works as it does on the Audit Trail: see [Moving through time](audit-trail.md#moving-through-time). Choose **Day**, **Week**, **Month** or **Year** to see a whole span, and **‹** or **›** to step back or forward. Select the words between the arrows to jump to a day, or to pick a rolling or custom range. There is no **All time**, because a chart must fit a size you can read. To look closer, zoom in: see [Zooming in on a stretch](#zooming-in-on-a-stretch).

## Choosing metrics and buckets

1. Select **Metrics** in the toolbar and tick the metrics you want to chart. It starts at **All metrics**. A long list has a search box.
2. Select **Buckets** to choose the bucket size. It starts at **Auto**, the smallest size that fits.
3. Select **Clear filters** to go back to **Last 24 hours**, every metric and **Auto**. The device stays.

The line above the charts says what you see, for example **3 of 10 metrics, in 1-minute buckets**.

Choosing fewer metrics gives smaller buckets, and so finer detail. Under **Auto**, the page picks the bucket size for the metrics you chose, not for all of them. See [Which bucket size you see](#which-bucket-size-you-see).

The address keeps the device, the window, the metrics and the bucket size, so a link you share opens the same charts. When you chart another device, it keeps the metrics it also has.

## Charts grouped by type

1. Select a group's name, such as **String**, to close it. Its charts are hidden.
2. Select the name again to open it.
3. Select **Collapse all** or **Expand all**, at the start of the line above the charts, to close or open every group.

The charts are grouped by the type of value each metric holds, as the Metrics page names it, in this order: **Double**, **Float**, the whole numbers (**Int8** to **UInt64**), **Boolean**, **String** and **Text**, then any other type. A metric the Metrics page does not list is under **Other**, last. Each group's name says how many charts it holds.

Closing a group only hides its charts. The **Metrics** filter, the bucket size and what the page reads stay the same. This browser remembers which groups you closed, on every device's page, but a link you share opens them all. The **Metrics** list in the toolbar is grouped the same way.

## Zooming in on a stretch

1. Press on a chart, or on a state's strip, and drag across the stretch you want. A shaded band follows the pointer, on every chart.
2. Read the band's words, such as **10:05 – 10:40, 35 min**. They say what the charts will show.
3. Let go. The charts show that stretch, in smaller buckets where the shorter window allows.
4. To go back to the window before, select **Back** in your browser.

Or use the buttons after **Day | Week | Month | Year**:

- **Zoom in** shows the middle half of the window.
- **Zoom out** shows a window twice as long, around the same middle. A window that would run past now ends at the current minute instead.

**Zoom in** stops at a window of one minute, and is greyed out there. Point at a button to see why it is greyed out.

A few things to know:

- **A drag must move at least 4 pixels.** A shorter one is a click, and changes nothing.
- **Press Escape during a drag** to cancel it.
- **On a touch screen, dragging scrolls the page.** Use the buttons to zoom.
- **A band shorter than one minute opens as one minute**, around its middle.
- **A zoomed window is a custom range,** so the arrows are called **Earlier** and **Later**.
- **Each zoom is a new step in your browser's history,** so **Back** undoes it. Stepping with **‹** or **›** adds no step.
- **A zoom keeps the metrics and the bucket size you chose.**

## Refreshing

1. Select **Refresh** to read the readings again now. The charts stay on screen while it reads.
2. To refresh by itself, choose how often in the list joined to **Refresh**: **Off**, **30 s**, **1 min** or **5 min**. It starts at **Off**.

Refreshing by itself works only while the window reaches now, such as **Last 24 hours** or today. A window that has ended, such as last Tuesday, cannot gain a reading, so the list is off and says why. **Refresh** still works.

## What a chart shows

Each chart is titled with the metric's name, with its unit in brackets when the Metrics page gives it one.

- **Latest**, at the right of the title line, is the newest reading in the window, for example **Latest 21.3 °C · 4 Nov 12:40**. The time is the start of the bucket the reading arrived in, not the moment it was sent. A carried bucket never counts, so a quiet machine shows its last real reading. A window with only carried buckets says **No reading in this window**.
- **Pointing at a chart** shows that bucket instead: its time, its average, and its lowest to highest reading.

- **A bucket** is a stretch of time, such as five minutes. A reading arrives whenever the machine sends one, which can be many times a minute. So each chart groups the readings into buckets of equal length, and draws one point for each.
- **The line** is each bucket's average.
- **The shaded band** around it runs from the bucket's lowest reading to its highest. A narrow band means the reading held steady; a wide one means it moved within the bucket.
- **A dashed line** means no reading arrived in those buckets. Machines send a reading only when a value changes, so a quiet stretch means the value stayed the same. The dashed line carries the last reading forward until the next one arrives. This is called **carried forward**.
- **The valid range** is a dotted line labelled **valid range**, where the device's schema sets a lowest or highest value. It is not an alarm limit. A reading outside it usually means a faulty sensor or a schema that is wrong for the machine. The range is also written beside the chart's title.
- **A flag**, a value that is true or false, steps between the two.
- **A state**, such as **ACTIVE** or **READY**, is a strip of boxes, one for each stretch the device held that state, with its name inside. A state's colour comes from its name, so it is the same on every chart and every device, and a new name gets a colour of its own. Two states can have similar colours, and a colour means nothing about the state, so the name is always written inside the box. A hatched part of a box was carried forward.
- **The key** under a state's strip lists each state with its colour and its share of the charted time, the most first. Time after now does not count. The key names the six states with the most time; the rest are counted together as **others**.
- **Pointing at a state's strip** shows the stretch under the pointer, for example **4 Nov 10:05 – 10:40 · RUNNING, 35 min**, and how much of it was carried forward.
- **Now** marks the present moment on a window that runs on past it, such as today's. The part after it is hatched and says **No readings yet**.
- **A shaded red stretch** means an alert on the device was firing then. A solid line marks where it started and where it ended, when that is inside the window. Its name is written inside the stretch when there is room. Point at it to read which alert it was, its severity and when it fired. Several alerts at once shade the same stretch more deeply.
- **The line above the charts** then also says how many alerts fired in the window, for example **Shaded while an alert was firing: 2 alerts in this window**. Select it to list them on the [Alerts](#alerts) tab. A state's strip is not shaded.

A chart with nothing to draw says **No readings in this window, and none before it**. A metric is listed when the device declared it the last time it started, or when one of its schemas includes it.

## Which bucket size you see

Under **Auto**, the page picks the bucket size for you, and says which it chose above the charts, for example **15 metrics, in 5-minute buckets**. There are four sizes:

- **1-minute buckets**
- **5-minute buckets**
- **1-hour buckets**
- **1-day buckets**

The page picks the smallest size that keeps one read to at most 5,000 points. A point is one bucket of one metric. So a longer window, or more metrics, gets larger buckets. For example, one metric over 24 hours fits in 1-minute buckets, but 15 metrics over the same day get 5-minute buckets. To see finer detail, choose fewer metrics or a shorter window.

**Buckets** also offers each size. A larger size than **Auto** picks is always on. A smaller one would need more than 5,000 points, so it is listed but off; point at it to see why. A link that asks for one is charted at the size **Auto** picks, and the line above the charts says so.

**Text charts get wider buckets under Auto.** In small buckets, the names in a state's strip run together and cannot be read. So under **Auto**, a text chart, such as a state, takes the smallest size whose buckets are each at least 3 pixels wide on the chart. A narrow screen or a long window gets larger buckets. The line above the charts says when text uses another size, for example **3 metrics, in 1-minute buckets; text in 5-minute buckets**. A larger bucket shows only the last value in it, so a state that lasted only part of a bucket may not show. To see every change, zoom in, or choose a size in **Buckets**, which every chart then uses, text included.

When even 1-day buckets would be too many for all the metrics at once, the page reads them in parts and says so. A window too long for one metric in 1-day buckets is not charted, and the page asks for a shorter one.

## Exporting readings

1. Choose the device, the window and the metrics, as above. The export saves what the charts show.
2. Select **Export CSV** in the toolbar. The dialog's first line says what it will save, for example **Lathe 3 · 3 metrics · Last 24 hours (4 Nov 12:41 – 5 Nov 12:41)**. The times are fixed when the dialog opens.
3. Choose the **Resolution**, then select **Export CSV** in the dialog. The file downloads.

The resolutions:

- **Raw samples**, the one the dialog starts on, is every reading as the machine sent it.
- **1 minute**, **5 minutes** and **1 hour** are summaries: each period's average, lowest, highest and last reading. The file's first line names the resolution, because the file is what gets passed on.

Each resolution says how far back it has data, because raw readings are kept for much less time than the summaries. If the window starts before the resolution you chose begins, the dialog says so, names the finest resolution that covers the whole window, and offers to switch. It never swaps in a summary by itself.

**Buckets** changes only the charts. The export has its own **Resolution**.

An export holds at most 50,000 rows, shared across the metrics. Once it reaches that, the later metrics are left out, and the dialog and the file's first lines say so.

Exporting needs permission to read telemetry. Without it, **Export CSV** is off and names the roles that have it.

## Alerts

The **Alerts** tab lists every alert that fired over the window, newest first. An alert that started before the window and was still firing in it is listed too.

1. Select **Alerts** under the page's name. It opens on **Last 24 hours**.
2. Choose the period in the **time window**, as on the Device tab. **Zoom in** and **Zoom out** work here too.
3. To see only some devices' or gateways' alerts, select **Asset** and tick them. It starts at **Every asset**.
4. Type in the search box to find an alert by its name, its summary, what it is about, or who acknowledged it.
5. Select a column's name to sort by it. Select it again to reverse the order, and a third time to go back to newest first.

You can also start from the alert counter in the top bar: select **Alert history** at the foot of its list. From a device's charts, select the number of alerts in the line above them.

Each row says:

- **Alert**: its name, with the summary it was raised with.
- **Severity**: **Critical**, **Warning** or **Info**.
- **Subject**: the device or gateway it was about. Select it to open its panel on the Devices or Gateways page. An alert about the whole platform says **Platform-wide**.
- **Started** and **Ended**: when it started and stopped firing. **Firing** means it still is.
- **Duration**: how long it fired, or how long so far.
- **Acknowledged**: who acknowledged it, the reason, when, and their note. A dash means nobody did. Acknowledging is done from the alert counter: see [The alert counter](site-map.md#the-alert-counter).

A few things to know:

- **An alert that fired again without first resolving** ends where the next one started. Its **Ended** says **(fired again)**. Point at it to see why.
- **Suppressed**, with a crossed-out bell under an alert's name, means a [suppression window](devices.md#suppression-windows) covered it while it fired. For that time it was not counted, and nothing was sent.
- **The list shows at most 1,000 alerts.** When more fired, the line above the list says so. Choose a shorter window or fewer assets.
- **Alerts are kept for 90 days.** An Administrator can change that on the **Settings** page: **Alert history kept for (days)**, on the **Retention** tab. A window older than that lists none, and the page says so. Who acknowledged an alert stays in the Audit Trail after the alert is gone.
- **Only an Administrator sees an alert about a machine identity's token.** For anyone else, an empty list says **No alert you may see fired in this window**.
- **Refresh** and its timer work as on the Device tab.
- **The address keeps the window, the assets and the search**, so a link you share opens the same list.

## What the states mean

- **Loading readings…** means the page is reading the device's metrics. A long window takes longer.
- **The readings could not be read** names what went wrong. Usually the database that holds the readings could not be reached. Select **Refresh** to try again.
- **No device answers to this address** means the link names a device that no longer exists. Select **Choose another device**.
- **This device has declared no metrics** means it has not started up since it was registered, and no schema attached to it lists any metric.
- **Loading alerts…** means the Alerts tab is reading the alerts in the window.
- **No alert fired in this window** means just that. With assets chosen, it says **No alert fired on the assets chosen in this window**.
- **The alerts could not be read** names what went wrong. Select **Refresh** to try again.

Nothing on this page changes anything.
