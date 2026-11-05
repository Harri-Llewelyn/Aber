## What this page is for

History shows a site's readings over a period you choose. Open it to see how a device has behaved: whether a temperature crept up overnight, when a spindle stopped, or what a reading was last Tuesday.

The page opens on **Overview**, its first tab. It shows where readings arrived from every device over the window, before anything is charted. The second tab, **Device**, draws one chart for each metric of one device, stacked down the page on the same time axis. Point at a chart to read the value at that moment; every chart shows the same moment. Otherwise each chart's title line shows its latest reading.

Everyone who can sign in can open History. Each lane and chart shows only what your account may read.

## The Overview: where readings arrived

1. Open **History** in the sidebar, directly below the Site Map. The Overview opens on **Last 24 hours**.
2. Each device has a **lane**: its name, its status dot, how many metrics it reports, and a strip across the window.
3. The strip is a row of **blocks**. A block is darker where more readings arrived. The key above the lanes reads **No readings**, then **Fewer readings → More readings**. Each strip is shaded against its own busiest block.
4. Read the line above the lanes for the block size, for example **48 devices, in 5-minute blocks**.

The strip never shows a reading's value, only how many arrived. A lane says **No readings since 15:00** when a device's readings stop inside the window. Machines send a reading only when a value changes, so a steady machine can be quiet for hours. The status dot says whether the device is online.

The lanes are grouped as the Site Map places devices: each area and its cells, the cells in no area, then **Site-Wide**, **Simulated** and **Unassigned**. Archived devices are not shown.

- **Select a group's name**, such as **Boardroom · 4 devices**, to close it. A closed group draws one strip, its devices' readings added together.
- **Select Collapse all or Expand all**, at the start of the line above the lanes, to close or open every group.
- This browser remembers which groups you opened and closed. On a first visit every group is open, unless there are more than 200 devices. Then every group starts closed.
- **Type in the search box** to show only the devices whose name, id, cell or area matches.

The part of the window after now is hatched and says **No readings yet**. A crosswise hatch marks a stretch the historian has not counted yet. After an upgrade it counts older history in the background, and the line above the lanes says so, for example **Coverage before 3 Oct is still being computed**.

### Charting or zooming from Overview

1. Press on a strip and drag across the lanes and the stretch of time you want. A box follows the pointer.
2. Let go. The box says what it holds, for example **3 devices · 10:05 – 14:20, 4 h 15 min**.
3. Select **Zoom** to show that stretch on Overview. **Back** in your browser undoes it.
4. Or select **Chart** to open that device's charts on the Device tab, over the box's stretch. Chart takes one device. Charting several comes with the Metric tab.

Press **Escape**, or press anywhere outside the box, to clear it.

You don't need to drag. Tick the box at the start of a lane to pick that device, and select **Chart** in the toolbar: it charts the device over the time window. The time window's **Zoom in** and **Zoom out** work here as on the Device tab. A lane's name also opens its charts.

### Long windows and many devices

The block size depends on how many devices Overview shows:

- **40 devices or fewer** get about one block for every 4 pixels of the strip, at any window up to a year. A block is never shorter than 5 minutes, so a short window has few blocks.
- **More than 40** get 5-minute blocks up to a day and 1-hour blocks up to 7 days. A longer window is not shown, and the page says why. To see one, type a cell's name in the search box, or narrow the list to 40 devices or fewer.

## Choosing a device and a window

1. Open **History** in the sidebar, directly below the Site Map, and select the **Device** tab. It lists every device.
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

## What the states mean

- **Loading readings…** means the page is reading the device's metrics. A long window takes longer.
- **The readings could not be read** names what went wrong. Usually the database that holds the readings could not be reached. Select **Refresh** to try again.
- **No device answers to this address** means the link names a device that no longer exists. Select **Choose another device**.
- **This device has declared no metrics** means it has not started up since it was registered, and no schema attached to it lists any metric.

Nothing on this page changes anything.
