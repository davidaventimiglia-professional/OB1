export const metadata = {
  title: "Open Brain — Authorize",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body
        style={{
          maxWidth: "28rem",
          margin: "4rem auto",
          padding: "0 1rem",
          fontFamily: "system-ui, sans-serif",
          lineHeight: 1.5,
        }}
      >
        {children}
      </body>
    </html>
  );
}
