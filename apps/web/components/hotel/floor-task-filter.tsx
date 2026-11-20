/** Liên kết GET cho bộ lọc buồng phòng, dùng cả khi trình duyệt tắt JavaScript. */
export function FloorTaskFilter({
  propertyId,
  floors,
  selected,
  label,
  all,
}: {
  propertyId: string;
  floors: ReadonlyArray<{ id: string; name: string }>;
  selected: string | undefined;
  label: string;
  all: string;
}) {
  if (floors.length < 2 && !selected) return null;
  const anchor = `#h-${propertyId}`;
  return (
    <nav className="pager" aria-label={label}>
      <a
        className={selected ? "btn btn--secondary" : "btn"}
        href={`/buong-phong${anchor}`}
        aria-current={selected ? undefined : "page"}
      >
        {all}
      </a>
      {floors.map((floor) => (
        <a
          key={floor.id}
          className={selected === floor.id ? "btn" : "btn btn--secondary"}
          href={`/buong-phong?${new URLSearchParams({ property: propertyId, floor: floor.id })}${anchor}`}
          aria-current={selected === floor.id ? "page" : undefined}
        >
          {floor.name}
        </a>
      ))}
    </nav>
  );
}
