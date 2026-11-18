### From 1.9.0, an archived gateway is refused a setup token

Asking for a setup token, an install command or a bundle for an archived gateway is now refused. Restore
the gateway first (migration `0309`).

It used to succeed. The token could not be used while the gateway was archived, but the gateway then
read **Awaiting setup**, and a restore brought it back holding a token that stayed live for up to a day.

The dashboard never offers **Set Up Gateway** for an archived gateway, so you only meet this if a script
of your own calls `issue_gateway_enrollment_token()`, or posts to the `gateway-bundle` function, for a
gateway you have archived. The function answers **400**, *That gateway is archived*. The database call
raises `invalid_parameter_value`, with *gateway X is archived; restore it before issuing a setup token*.

To set an archived gateway up again, restore it on the **Archived Entities** page or from its drawer.
Then set it up. Nothing needs doing before you upgrade.
