## What this page is for

History charts a machine's readings over a period you choose. Open it to see how a device has behaved: whether a temperature crept up overnight, when a spindle stopped, or what a reading was last Tuesday.

The page has one tab, **Device**. It draws one chart for each metric of one device, stacked down the page on the same time axis. Point at a chart to read the value at that moment; every chart shows the same moment.

Everyone who can sign in can open History. Each chart shows only what your account may read.

## Choosing a device and a window

1. Open **History** in the sidebar, directly below the Site Map. It lists every device.
2. Type in the search box to find a device by its name, its id, its cell or its area. Select its name.
3. Choose the period in the **time window**, after the device's name. It opens on **Last 24 hours**.
4. To chart another device, select its name in the toolbar and pick one from the list.

You can also start from a device. On the Devices page, open the device and select **View History**.

The time window works as it does on the Audit Trail: see [Moving through time](audit-trail.md#moving-through-time). Choose **Day**, **Week**, **Month** or **Year** to see a whole span, and **‹** or **›** to step back or forward. Select the words between the arrows to jump to a day, or to pick a rolling or custom range. There is no **All time**, because a chart must fit a size you can read.

The address keeps the device and the window, so a link you share opens the same charts.

## Refreshing

1. Select **Refresh** to read the readings again now. The charts stay on screen while it reads.
2. To refresh by itself, choose how often in the list joined to **Refresh**: **Off**, **30 s**, **1 min** or **5 min**. It starts at **Off**.

Refreshing by itself works only while the window reaches now, such as **Last 24 hours** or today. A window that has ended, such as last Tuesday, cannot gain a reading, so the list is off and says why. **Refresh** still works.

## What a chart shows

Each chart is titled with the metric's name, with its unit in brackets when the Metrics page gives it one.

- **A bucket** is a stretch of time, such as five minutes. A reading arrives whenever the machine sends one, which can be many times a minute. So each chart groups the readings into buckets of equal length, and draws one point for each.
- **The line** is each bucket's average.
- **The shaded band** around it runs from the bucket's lowest reading to its highest. A narrow band means the reading held steady; a wide one means it moved within the bucket.
- **A dashed line** means no reading arrived in those buckets. Machines send a reading only when a value changes, so a quiet stretch means the value stayed the same. The dashed line carries the last reading forward until the next one arrives. This is called **carried forward**.
- **The valid range** is a dotted line labelled **valid range**, where the device's schema sets a lowest or highest value. It is not an alarm limit. A reading outside it usually means a faulty sensor or a schema that is wrong for the machine. The range is also written beside the chart's title.
- **A flag**, a value that is true or false, steps between the two.
- **A state**, such as **ACTIVE** or **READY**, is a strip of boxes, one for each stretch the device held that state, with its name inside.
- **Now** marks the present moment on a window that runs on past it, such as today's. The part after it is hatched and says **No readings yet**.

A chart with nothing to draw says **No readings in this window, and none before it**. A metric is listed when the device declared it the last time it started, or when one of its schemas includes it.

## Which bucket size you see

The page picks the bucket size for you, and says which it chose above the charts, for example **15 metrics, in 5-minute buckets**. There are four sizes:

- **1-minute buckets**
- **5-minute buckets**
- **1-hour buckets**
- **1-day buckets**

The page picks the smallest size that keeps one read to at most 5,000 points. A point is one bucket of one metric. So a longer window, or a device with more metrics, gets larger buckets. For example, one metric over 24 hours fits in 1-minute buckets, but 15 metrics over the same day get 5-minute buckets. To see finer detail, choose a shorter window.

When even 1-day buckets would be too many for all the metrics at once, the page reads them in parts and says so. A window too long for one metric in 1-day buckets is not charted, and the page asks for a shorter one.

## What the states mean

- **Loading readings…** means the page is reading the device's metrics. A long window takes longer.
- **The readings could not be read** names what went wrong. Usually the database that holds the readings could not be reached. Select **Refresh** to try again.
- **No device answers to this address** means the link names a device that no longer exists. Select **Choose another device**.
- **This device has declared no metrics** means it has not started up since it was registered, and no schema attached to it lists any metric.

Nothing on this page changes anything. To see each metric's newest reading, use **View Telemetry** on the device's panel on the Devices page.
