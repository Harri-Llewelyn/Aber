## What this page is for

This page is yours. It shows the account you are signed in with, and how the dashboard looks to you. What you choose here applies to you, on any browser you sign in on. It does not change anything for anyone else.

To open it, select your avatar at the foot of the sidebar, then select **Profile**.

The settings for the whole site are on the **Settings** page, not here.

## What the controls do

- **Account** shows your email address and your role. Your email address is how you sign in, and it cannot be changed here. Only an Administrator can change your role, on the **Access Control** page.
- **Change Password**, on the **Password** row, opens a dialog. Give your current password, then the new one twice. The new one needs at least 12 characters. Your other sessions are signed out. The session you are using stays open.
- **Copy Token**, on the **Access token** row, copies your access token. The page never shows the token itself. The row shows the time it stops working. **Calling the API as yourself**, below, says where to paste it.
- **Copy Key**, on the **Publishable key** row, copies the site's publishable key. Some tools ask for it beside your token. It is public: every browser that opens the dashboard is given it.
- **Appearance** holds your **Theme** (dark or light), your **Sidebar layout** and your **Single-key shortcuts**. Choose a value, then select **Save** on its row. **Discard** puts back the value you had.
- **Sidebar layout** has three choices. **Expand on hover** shows the page names while the pointer is over the sidebar. **Expanded** always shows them, and the page makes room. **Collapsed** shows icons only.
- **Single-key shortcuts** are keys that act on one press. `?` opens the list of shortcuts. `/` goes to the page's search box. `[` and `]` move to the previous and next tab. They are on unless you turn them off. Turn them off if you use speech input, which can type them by mistake. Ctrl K and the arrow keys still work. The **Keyboard shortcuts** button in the top bar still opens the list.
- **The Theme and Sidebar layout switches in the account menu** change the same settings as this page. They apply at once, with nothing to save. Use whichever is nearest. In the account menu, select **Light** or **Dark** for the theme. For the sidebar, select **Hover** (Expand on hover), **Expanded** or **Collapsed**.
- **Sign Out**, in the account menu, signs you out of this browser. It signs this browser out of Studio and the forge too. Your other browsers stay signed in, and so do Grafana and Node-RED, which keep their own sign-in. To sign out everywhere else, change your password.
- **A browser you do not use for 7 days** asks you to sign in again. An open dashboard keeps itself signed in, so a wall display stays open. The site can set another time, or none.

## Calling the API as yourself

Your access token lets another tool act as you. Use it to try the API in Swagger UI, to browse in i3X Explorer, or in one curl request. You do not type your password into any of them.

1. On the **Account** tab, select **Copy Token** on the **Access token** row.
2. Paste the token into the tool:
   - **Swagger UI** (`https://docs.<domain>`): select **Authorize**. Paste the token under **bearerAuth**, without the word "Bearer". Then come back to this page and select **Copy Key**. Paste the key under **apiKeyAuth**.
   - **i3X Explorer**: set **Authentication** to **Bearer Token**, and paste the token.
3. When the token stops working, select **Copy Token** again. You get the current one.

What the token can do:

- It acts as you, with your role. Anyone who holds it can do what you can, so keep it to yourself.
- On a standard install it lasts at most an hour from when it was issued. The row shows the exact time.
- Signing out of this browser ends it.
- The dashboard renews its own token before it runs out. It does not renew the copy you made.

A tool that needs a token that lasts longer, such as a script or a service, should not use yours. It uses a machine identity's token instead. A machine identity is an account for software, not a person. An Administrator issues its token on the **Access Control** page.

## Where your choices are kept

Your choices are saved with your account, so they follow you to another PC. On a shared PC, the next person to sign in gets their own choices, not yours.

This browser also keeps a copy. The page uses it to show your theme straight away, before your account answers. The sign-in page uses it too, so it shows the theme last used on this PC.

The first time you sign in after this page was added, your account takes the choices this browser already had.

## If your choices cannot be saved

Sometimes your account cannot be reached, for example while the network is down. Then Appearance shows a warning. The page uses this browser's choices instead.

A change you make then applies in this browser only. The next time you sign in, your account's choices come back.

## What is not here

There is no display name. Aber names you by your email address.

Your notification history is not kept here. It belongs to the browser tab, and it is cleared when you sign out.
