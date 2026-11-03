import type { ReactNode } from 'react';

interface TableProps<T> {
  headers: string[];
  rows: T[];
  renderRow: (item: T) => ReactNode[];
  empty?: string;
}

export default function Table<T>({ headers, rows, renderRow, empty = 'No hay datos para mostrar.' }: TableProps<T>) {
  if (rows.length === 0) return <p className="nx-empty">{empty}</p>;

  return (
    <div className="nx-table-wrap">
      <table className="nx-table">
        <thead>
          <tr>{headers.map((header, index) => <th scope="col" key={`${header}-${index}`}>{header}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {renderRow(row).map((cell, cellIndex) => <td key={cellIndex}>{cell}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
