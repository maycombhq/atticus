export default function Thread({ chatId, messages }) {
  const remove = (id) => fetch(`/api/chats/${chatId}/messages/${id}`, { method: "DELETE" });
  return (
    <ul>
      {messages.map((m) => (
        <li key={m.id}>
          {m.text}
          <button onClick={() => remove(m.id)}>Delete</button>
        </li>
      ))}
    </ul>
  );
}
