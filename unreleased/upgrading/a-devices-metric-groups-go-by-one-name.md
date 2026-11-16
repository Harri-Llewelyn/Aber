### From 1.9.0, a device's metric groups go by one name

The Devices page called a device's metric groups **Type**, **Classification** and **Device Type**.
They are now **Metric groups** everywhere: the roster's column, the filter, the details panel's row
and the line in **Edit Details**. You do not need to do anything.

Two findings were listed among the groups: **Unmodelled** and **Out of vocabulary**. They are not
groups, so they have moved:

- **In the roster,** they are warning badges in the **Status** column. In the details panel, they are
  warning badges beside the state.
- **In the filters,** **Out of vocabulary** joins **Publishing unmodelled metrics** in **Status**, and
  **Needs attention** now counts it.

A link or a bookmark that used the old filter still works. Opening it rewrites the address once:

| Old link | Opens |
| :--- | :--- |
| `/devices?type=Axes` | **Metric groups** on **Axes**, as `/devices?group=Axes` |
| `/devices?type=Unmodelled` | **Status** on **Publishing unmodelled metrics** |
| `/devices?type=Out of vocabulary` | **Status** on **Out of vocabulary** |

A bookmark that sorted by the old column (`?sort=type`) opens in the usual order. Sort by **Metric
groups** again to save a new one.
