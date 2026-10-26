## What this page is for

This page is yours. It shows the account you are signed in with, how the dashboard looks to you, and where you are signed in. What you choose here applies to you, on any browser you sign in on. It does not change anything for anyone else.

To open it, select your avatar at the foot of the sidebar, then select **Profile**.

The settings for the whole site are on the **Settings** page, not here.

## What the controls do

- **Account** shows your email address and your role. Your email address is how you sign in, and it cannot be changed here. Only an Administrator can change your role, on the **Access Control** page.
- **Display name**, on the **Account** tab, is the name other people see you by. Type it, then select **Save**. To remove it, empty the box and select **Save**. **Your display name**, below, says where it shows.
- **Change Password**, on the **Password** row, opens a dialog. Give your current password, then the new one twice. The new one needs at least 12 characters. Your other sessions are signed out. The session you are using stays open.
- **Copy Token**, on the **Access token** row, copies your access token. The page never shows the token itself. The row shows the time it stops working. **Calling the API as yourself**, below, says where to paste it.
- **Copy Key**, on the **Publishable key** row, copies the site's publishable key. Some tools ask for it beside your token. It is public: every browser that opens the dashboard is given it.
- **Appearance** holds your **Theme** (dark or light), your **Sidebar layout** and your **Single-key shortcuts**. Choose a value, then select **Save** on its row. **Discard** puts back the value you had.
- **Sidebar layout** has three choices. **Expand on hover** shows the page names while the pointer is over the sidebar. **Expanded** always shows them, and the page makes room. **Collapsed** shows icons only.
- **Single-key shortcuts** are keys that act on one press. `?` opens the list of shortcuts. `/` goes to the page's search box. `[` and `]` move to the previous and next tab. They are on unless you turn them off. Turn them off if you use speech input, which can type them by mistake. Ctrl K and the arrow keys still work. The **Keyboard shortcuts** button in the top bar still opens the list.
- **The Theme and Sidebar layout switches in the account menu** change the same settings as this page. They apply at once, with nothing to save. Use whichever is nearest. In the account menu, select **Light** or **Dark** for the theme. For the sidebar, select **Hover** (Expand on hover), **Expanded** or **Collapsed**.
- **Security** lists every place you are signed in: each browser, each program and each service. **Your sessions**, below, says what it shows.
- **End**, on a row of the **Security** tab, signs that session out. The session you are using has no **End**: use **Sign Out** for it.
- **Sign Out of All Other Sessions**, on the **Security** tab, signs out every session but the one you are using. A dialog says what it ends before anything happens.
- **Sign Out**, in the account menu, signs you out of the dashboard in this browser. Your other browsers stay signed in, and so do Grafana and Node-RED, which keep their own sign-in. It also signs you out of Studio and the forge, in every browser. Where the dashboard is still signed in, they sign you in again by themselves. To sign out everywhere else, use **Sign Out of All Other Sessions** on the **Security** tab.
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

## Your display name

Your display name is shown first wherever you appear. Your email address stays the way you sign in.

- **On the Audit Trail, Approvals and People, your email address is always shown beside the name.** Two people can have the same name, and anyone can type any name. The email address tells them apart.
- **In the account menu and on Archived Entities, the email address is shown when you point at the name.**
- **Without a display name,** you are shown by your email address alone.
- **It can be up to 80 characters.** Spaces at either end are removed. A line break, a tab or another control character is refused.
- **An Administrator can also set it,** with **Change Name** on the **People** tab of **Access Control**.
- **Each change is recorded in the Audit Trail,** with the old name, the new name and who changed it.

**A new name shows everywhere at once.** Pages read the name when they open. So a person who changes their name is shown under the new one, even beside things they did before.

**The email address beside it is the one they had at the time.** Approvals keeps the address a proposal was made from. Archived Entities keeps the address of the person who deleted the entity. The Audit Trail and People show the address the account has now.

## Your sessions

A session is one sign-in. Each browser you sign in on has its own. So do Grafana, Node-RED, Studio and the forge, and any program that signs in as you.

The **Security** tab lists your sessions and nobody else's. The one you are using comes first, marked **This browser**. The rest follow, the most recently used first.

- **Where** names the browser and the system, such as "Chrome on Windows". A script or other program shows as "A program". Point at the name to see what the browser reported in full.
- **A service's session** shows the service, such as "Grafana", marked **Service**. Studio and the forge are listed the same way. The service signed you in from its own server, so the list cannot say which device you used.
- **No address is recorded** for any session.
- **Started** is when you signed in. **Last active** is when the session last renewed its access. An open dashboard renews about once an hour.

What ending a session does:

- **The API refuses it at once.** A dashboard open with that session asks for a sign-in on its next request.
- **Studio and the forge** refuse it on their next request.
- **Node-RED's editor** signs you out within a minute.
- **Grafana** signs you out when its access runs out: within an hour on a standard install.
- **Nothing is written to the Audit Trail.** Ending your own session changes nothing for anyone else.

**A session nobody uses for 7 days ends by itself.** It can stay listed for about a day after that. The site can set another time, or none.

## What is not here

Your notification history is not kept here. It belongs to the browser tab, and it is cleared when you sign out.
